import { createHash } from "node:crypto";
import type {
  HarnessProfileCapabilities,
  HarnessProfileManifestV1,
  HarnessProfileResolvedVersion,
  HarnessResolvedSkillArtifact,
  HarnessRunManifestRecord,
  HarnessToolId,
  WorkflowBlockType,
} from "@shared/contracts";
import {
  HARNESS_MCP_INTEGRATION_IDS,
  HARNESS_TOOL_IDS,
} from "@shared/contracts";
import type {
  AgentRuntimePaths,
  RunnableSandbox,
  SerializableAgentCliSpec,
} from "./agents/types.js";
import { AGENT_CLI_SPEC_CATALOG } from "./agents/protocol.js";
import { hashHarnessProfileManifest } from "../harness-profiles/manifest.js";
import { verifyHarnessSkillArtifact } from "../harness-profiles/skill-artifact.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const SAFE_FILE_MODES = new Set([
  0o400,
  0o444,
  0o500,
  0o555,
  0o600,
  0o640,
  0o644,
  0o700,
  0o750,
  0o755,
]);

export const HARNESS_TOOL_CATALOG = new Set<string>(
  HARNESS_TOOL_IDS,
);

/**
 * MCP configuration is deliberately closed until an integration has a
 * code-owned materializer. Persisted arbitrary server commands must never
 * become an execution path merely because they appeared in a profile row.
 */
export const HARNESS_MCP_INTEGRATION_CATALOG = new Set<string>(
  HARNESS_MCP_INTEGRATION_IDS,
);

export const HARNESS_CREDENTIAL_REFERENCE_CATALOG = new Set([
  "anthropic",
  "openai",
  "github",
  "gitlab",
  "jira",
  "slack",
] as const);

const AGENT_BLOCK_TYPES = new Set<WorkflowBlockType>([
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
]);

const TOOL_ENVELOPE: Record<
  Extract<
    WorkflowBlockType,
    | "planning_agent"
    | "implementation_agent"
    | "review_agent"
    | "fix_agent"
    | "generic_agent"
  >,
  ReadonlySet<string>
> = {
  planning_agent: new Set(["filesystem", "shell", "git"]),
  implementation_agent: new Set(["filesystem", "shell", "git"]),
  review_agent: new Set(["filesystem", "shell", "git"]),
  fix_agent: new Set(["filesystem", "shell", "git"]),
  generic_agent: new Set(["filesystem", "shell", "git"]),
};

export interface ResolvedHarnessRuntime {
  manifest: HarnessProfileManifestV1;
  manifestHash: string;
  cliSpec: SerializableAgentCliSpec;
  paths: AgentRuntimePaths;
  capabilities: HarnessProfileCapabilities;
  safeManifest: HarnessRunManifestRecord;
  /**
   * V1 keeps the pre-profile skills.sh compatibility setup. V2 is always
   * deterministic and materializes only the pinned artifact bytes above.
   */
  legacyDynamicSkills: boolean;
}

export interface RuntimeCredentialSource {
  anthropicApiKey?: string;
  codexApiKey?: string;
  codexChatGptOauthToken?: string;
}

export interface ResolvedRuntimeCredentials {
  anthropicApiKey?: string;
  codexApiKey?: string;
  codexChatGptOauthToken?: string;
}

export function resolveHarnessRuntime(input: {
  nodeId: string;
  nodeType: WorkflowBlockType;
  workspaceMode?: unknown;
  resolved: HarnessProfileResolvedVersion;
  legacyDynamicSkills?: boolean;
}): ResolvedHarnessRuntime {
  if (!AGENT_BLOCK_TYPES.has(input.nodeType)) {
    throw new Error(`Block "${input.nodeId}" does not execute an agent harness.`);
  }
  const manifest = structuredClone(input.resolved.manifest);
  const manifestHash = normalizeSha256(
    input.resolved.manifestHash,
    "Harness Profile manifest hash",
  );
  validateManifestIdentity(manifest);
  if (hashHarnessProfileManifest(manifest) !== manifestHash) {
    throw new Error(
      `Harness Profile "${manifest.profileId}" version ${manifest.version} failed manifest hash verification.`,
    );
  }
  const cliSpec = profileCliSpec(manifest);
  const capabilities = resolveHarnessCapabilities({
    nodeType: input.nodeType,
    workspaceMode: input.workspaceMode,
    manifest,
  });
  validatePinnedArtifacts(manifest, input.resolved.skillArtifacts);
  const paths = runtimePathsForManifestHash(
    manifest.harness.provider,
    manifestHash,
  );
  const safeManifest = buildSafeRunHarnessManifest({
    nodeId: input.nodeId,
    manifest,
    manifestHash,
    skillArtifacts: input.resolved.skillArtifacts,
    capabilities,
  });
  return {
    manifest,
    manifestHash,
    cliSpec,
    paths,
    capabilities,
    safeManifest,
    legacyDynamicSkills: input.legacyDynamicSkills === true,
  };
}

export function resolveHarnessCapabilities(input: {
  nodeType: WorkflowBlockType;
  workspaceMode?: unknown;
  manifest: HarnessProfileManifestV1;
}): HarnessProfileCapabilities {
  if (!AGENT_BLOCK_TYPES.has(input.nodeType)) {
    throw new Error(`Block type "${input.nodeType}" has no harness safety envelope.`);
  }
  const requestedTools = uniqueSorted(input.manifest.tools);
  for (const tool of requestedTools) {
    if (!HARNESS_TOOL_CATALOG.has(tool as HarnessToolId)) {
      throw new Error(`Harness tool "${tool}" is not in the code-owned catalog.`);
    }
  }
  const requestedMcpIntegrations = uniqueSorted(
    input.manifest.mcpIntegrations,
  );
  for (const integration of requestedMcpIntegrations) {
    if (!HARNESS_MCP_INTEGRATION_CATALOG.has(integration)) {
      throw new Error(
        `Harness MCP integration "${integration}" is not in the code-owned catalog.`,
      );
    }
  }

  const envelope = TOOL_ENVELOPE[
    input.nodeType as keyof typeof TOOL_ENVELOPE
  ];
  const tools = requestedTools.filter(
    (tool) => envelope.has(tool),
  ) as HarnessToolId[];
  const effectiveToolIds = new Set<string>(tools);
  const clippedTools = requestedTools.filter(
    (tool) => !effectiveToolIds.has(tool),
  );
  const mcpIntegrations: HarnessProfileCapabilities["mcpIntegrations"] = [];
  const clippedMcpIntegrations = [...requestedMcpIntegrations];

  const requestedSubagents = input.manifest.subagents.enabled;
  // Neither provider adapter currently has a stable, versioned switch that
  // enforces both enablement and max concurrency. Keep the declaration visible
  // but clip it until a code-owned provider contract can enforce it.
  const subagentsAllowed = false;
  const subagentsEnabled = requestedSubagents && subagentsAllowed;
  return {
    requestedTools,
    tools,
    clippedTools,
    requestedMcpIntegrations,
    mcpIntegrations,
    clippedMcpIntegrations,
    subagents: {
      requested: requestedSubagents,
      enabled: subagentsEnabled,
      maxConcurrent: subagentsEnabled
        ? input.manifest.subagents.maxConcurrent
        : 0,
      clipped: requestedSubagents !== subagentsEnabled,
    },
  };
}

export function resolveRuntimeCredentials(
  manifest: HarnessProfileManifestV1,
  source: RuntimeCredentialSource,
): ResolvedRuntimeCredentials {
  const references = uniqueSorted(manifest.credentialReferences);
  for (const reference of references) {
    if (!HARNESS_CREDENTIAL_REFERENCE_CATALOG.has(reference as never)) {
      throw new Error(
        `Credential reference "${reference}" is not in the code-owned catalog.`,
      );
    }
  }
  const requiredReference =
    manifest.harness.provider === "claude" ? "anthropic" : "openai";
  if (
    references.length !== 1 ||
    references[0] !== requiredReference
  ) {
    throw new Error(
      "The current runtime supports only the Harness Profile provider credential reference.",
    );
  }
  if (manifest.harness.provider === "claude") {
    if (!references.includes("anthropic") || !source.anthropicApiKey) {
      throw new Error(
        "The pinned Claude Harness Profile requires an unavailable symbolic credential.",
      );
    }
    return { anthropicApiKey: source.anthropicApiKey };
  }
  if (
    !references.includes("openai") ||
    (!source.codexApiKey && !source.codexChatGptOauthToken)
  ) {
    throw new Error(
      "The pinned Codex Harness Profile requires an unavailable symbolic credential.",
    );
  }
  return {
    ...(source.codexApiKey
      ? { codexApiKey: source.codexApiKey }
      : {}),
    ...(source.codexChatGptOauthToken
      ? { codexChatGptOauthToken: source.codexChatGptOauthToken }
      : {}),
  };
}

export function runtimePathsForManifestHash(
  provider: "claude" | "codex",
  manifestHash: string,
): AgentRuntimePaths {
  const hash = normalizeSha256(manifestHash, "Harness Profile manifest hash");
  const rootDir = `/tmp/aiw-harness/${hash}`;
  return {
    manifestHash: hash,
    rootDir,
    homeDir: `${rootDir}/home`,
    cliDir: `${rootDir}/cli`,
    executablePath: `${rootDir}/cli/node_modules/.bin/${
      provider === "claude" ? "claude" : "codex"
    }`,
    envPath: `${rootDir}/credentials.sh`,
  };
}

/**
 * Select one profile for an invocation. Profile homes can contain provider
 * auth, hooks, and executable skill code, so no sibling home is allowed to
 * survive in the same outer sandbox. The active home is rebuilt from pinned
 * bytes immediately afterwards.
 */
export async function resetHarnessRuntimeHomes(
  sandbox: RunnableSandbox,
): Promise<void> {
  const reset = await sandbox.runCommand("bash", [
    "-c",
    [
      "set -eu",
      "if [ -d /tmp/aiw-harness ]; then",
      "  find /tmp/aiw-harness -mindepth 2 -maxdepth 2 -type d -name home -exec rm -rf -- {} +",
      "  find /tmp/aiw-harness -mindepth 2 -maxdepth 2 -type d -name cli -exec rm -rf -- {} +",
      "  find /tmp/aiw-harness -mindepth 2 -maxdepth 2 -type f -name credentials.sh -delete",
      "fi",
    ].join("\n"),
  ]);
  if (reset.exitCode !== 0) {
    throw new Error("The Harness Profile invocation boundary could not be reset.");
  }
}

export async function materializePinnedHarnessFiles(
  sandbox: RunnableSandbox,
  runtime: ResolvedHarnessRuntime,
  skillArtifacts: readonly HarnessResolvedSkillArtifact[],
): Promise<void> {
  const directories = new Set<string>([
    runtime.paths.rootDir,
    runtime.paths.homeDir,
    runtime.paths.cliDir,
  ]);
  const writes: Array<{ path: string; content: Buffer }> = [];
  const verifications: Array<{
    path: string;
    sha256: string;
    mode: number;
  }> = [];

  for (const file of runtime.manifest.homeFiles) {
    const relativePath = validateRelativeFilePath(file.path);
    validateFileMode(file.mode);
    validateSafeProfileHomeFile(
      runtime.manifest.harness.provider,
      relativePath,
      file.mode,
    );
    const path = `${runtime.paths.homeDir}/${relativePath}`;
    const content = Buffer.from(file.content, "utf8");
    addParentDirectories(directories, path);
    writes.push({ path, content });
    verifications.push({
      path,
      sha256: sha256(content),
      mode: file.mode,
    });
  }

  const skillRoot =
    runtime.manifest.harness.provider === "claude"
      ? `${runtime.paths.homeDir}/.claude/skills`
      : `${runtime.paths.homeDir}/.agents/skills`;
  for (const skill of runtime.manifest.skills) {
    const artifact = skillArtifacts.find(
      (candidate) => candidate.artifactHash === skill.artifactHash,
    );
    if (!artifact) {
      throw new Error(
        `Pinned skill artifact "${skill.artifactHash}" is unavailable.`,
      );
    }
    if (artifact.name !== skill.name) {
      throw new Error(
        `Pinned skill "${skill.name}" does not match its canonical artifact name.`,
      );
    }
    verifyHarnessSkillArtifact(artifact);
    const skillName = validatePathSegment(skill.name, "skill name");
    for (const file of artifact.files) {
      const relativePath = validateRelativeFilePath(file.path);
      validateFileMode(file.mode);
      const content = Buffer.from(file.contentBase64, "base64");
      if (content.byteLength !== file.sizeBytes) {
        throw new Error(
          `Pinned skill "${skill.name}" file "${file.path}" has an invalid size.`,
        );
      }
      const expectedHash = normalizeSha256(
        file.sha256,
        `Pinned skill "${skill.name}" file hash`,
      );
      if (sha256(content) !== expectedHash) {
        throw new Error(
          `Pinned skill "${skill.name}" file "${file.path}" failed hash verification.`,
        );
      }
      const path = `${skillRoot}/${skillName}/${relativePath}`;
      addParentDirectories(directories, path);
      writes.push({ path, content });
      verifications.push({ path, sha256: expectedHash, mode: file.mode });
    }
  }

  for (const directory of [...directories].sort(
    (left, right) => left.length - right.length,
  )) {
    const created = await sandbox.runCommand("mkdir", ["-p", directory]);
    if (created.exitCode !== 0) {
      throw new Error("The pinned Harness Profile home could not be prepared.");
    }
  }
  if (writes.length > 0) await sandbox.writeFiles(writes);

  for (const file of verifications) {
    const chmod = await sandbox.runCommand("chmod", [
      file.mode.toString(8),
      file.path,
    ]);
    if (chmod.exitCode !== 0) {
      throw new Error(
        "A pinned Harness Profile file mode could not be applied.",
      );
    }
    const digest = await sandbox.runCommand("sha256sum", [file.path]);
    if (digest.exitCode !== 0) {
      throw new Error(
        "A pinned Harness Profile file could not be verified.",
      );
    }
    const actual = (await digest.stdout()).trim().split(/\s+/, 1)[0];
    if (actual !== file.sha256) {
      throw new Error(
        "A pinned Harness Profile file changed during materialization.",
      );
    }
  }
}

function profileCliSpec(
  manifest: HarnessProfileManifestV1,
): SerializableAgentCliSpec {
  const supported = AGENT_CLI_SPEC_CATALOG.find(
    (candidate) =>
      candidate.kind === manifest.harness.provider &&
      candidate.packageName === manifest.harness.packageName &&
      candidate.version === manifest.harness.cliVersion &&
      candidate.protocol === manifest.harness.protocolVersion,
  );
  if (!supported) {
    throw new Error(
      `Harness runtime ${manifest.harness.provider}:${manifest.harness.packageName}@${manifest.harness.cliVersion}/${manifest.harness.protocolVersion} is not in the append-only code-owned catalog.`,
    );
  }
  if (!SEMVER_PATTERN.test(manifest.harness.cliVersion)) {
    throw new Error("Harness CLI version must be an exact semantic version.");
  }
  return {
    kind: supported.kind,
    packageName: supported.packageName,
    executable: supported.executable,
    version: manifest.harness.cliVersion,
    protocol: manifest.harness.protocolVersion,
  };
}

function validateManifestIdentity(manifest: HarnessProfileManifestV1): void {
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.profileId ||
    !Number.isInteger(manifest.version) ||
    manifest.version < 1
  ) {
    throw new Error("Harness Profile identity is invalid.");
  }
  if (!manifest.model.id.trim()) {
    throw new Error("Harness Profile model is missing.");
  }
  if (
    manifest.workspace.mode !== "managed" ||
    manifest.compaction.mode !== "provider_default"
  ) {
    throw new Error("Harness Profile contains an unsupported runtime mode.");
  }
  const declaredTools = uniqueSorted(manifest.tools);
  const supportedTools = uniqueSorted(HARNESS_TOOL_IDS);
  if (
    declaredTools.length !== supportedTools.length ||
    declaredTools.some((tool, index) => tool !== supportedTools[index])
  ) {
    throw new Error(
      "Harness Profile tool subsets are not supported by the current provider runtimes.",
    );
  }
  if (Object.keys(manifest.model.options).length > 0) {
    throw new Error(
      "Harness Profile model options are not supported by the current runtime.",
    );
  }
}

function validatePinnedArtifacts(
  manifest: HarnessProfileManifestV1,
  artifacts: readonly HarnessResolvedSkillArtifact[],
): void {
  const expected = new Map(
    manifest.skills.map((skill) => [skill.artifactHash, skill.name]),
  );
  if (expected.size !== manifest.skills.length) {
    throw new Error("Harness Profile contains a duplicate skill artifact.");
  }
  const actual = new Set<string>();
  for (const artifact of artifacts) {
    const expectedName = expected.get(artifact.artifactHash);
    if (!expectedName || expectedName !== artifact.name) {
      throw new Error(
        `Resolved skill artifact "${artifact.artifactHash}" is not pinned by the Harness Profile.`,
      );
    }
    if (actual.has(artifact.artifactHash)) {
      throw new Error("Resolved Harness Profile contains a duplicate skill artifact.");
    }
    actual.add(artifact.artifactHash);
  }
  if (actual.size !== expected.size) {
    throw new Error("One or more pinned Harness Profile skills are unavailable.");
  }
}

function buildSafeRunHarnessManifest(input: {
  nodeId: string;
  manifest: HarnessProfileManifestV1;
  manifestHash: string;
  skillArtifacts: readonly HarnessResolvedSkillArtifact[];
  capabilities: HarnessProfileCapabilities;
}): HarnessRunManifestRecord {
  const homeFileProvenance = input.manifest.homeFiles
    .map((file) => ({
      path: file.path,
      mode: file.mode,
      sha256: sha256(file.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const declaredCapabilities = [
    ...input.capabilities.requestedTools.map((tool) => `tool:${tool}`),
    ...input.capabilities.requestedMcpIntegrations.map(
      (integration) => `mcp:${integration}`,
    ),
    ...(input.capabilities.subagents.requested ? ["subagents"] : []),
  ];
  const effectiveCapabilities = [
    ...input.capabilities.tools.map((tool) => `tool:${tool}`),
    ...input.capabilities.mcpIntegrations.map(
      (integration) => `mcp:${integration}`,
    ),
    ...(input.capabilities.subagents.enabled ? ["subagents"] : []),
  ];
  const clippedCapabilities = [
    ...input.capabilities.clippedTools.map((tool) => `tool:${tool}`),
    ...input.capabilities.clippedMcpIntegrations.map(
      (integration) => `mcp:${integration}`,
    ),
    ...(input.capabilities.subagents.clipped ? ["subagents"] : []),
  ];
  return {
    nodeId: input.nodeId,
    reference: {
      profileId: input.manifest.profileId,
      version: input.manifest.version,
    },
    manifestHash: input.manifestHash,
    manifest: {
      schemaVersion: 1,
      profileId: input.manifest.profileId,
      version: input.manifest.version,
      slug: input.manifest.slug,
      displayName: input.manifest.displayName,
      system: input.manifest.system,
      harness: structuredClone(input.manifest.harness),
      model: structuredClone(input.manifest.model),
      context: structuredClone(input.manifest.context),
      compaction: structuredClone(input.manifest.compaction),
      subagents: structuredClone(input.manifest.subagents),
      limits: structuredClone(input.manifest.limits),
      workspace: structuredClone(input.manifest.workspace),
      instructionsSha256: sha256(input.manifest.instructions),
      homeFiles: {
        count: input.manifest.homeFiles.length,
        totalBytes: input.manifest.homeFiles.reduce(
          (total, file) => total + Buffer.byteLength(file.content),
          0,
        ),
        sha256: sha256(JSON.stringify(homeFileProvenance)),
      },
      skills: structuredClone(input.manifest.skills),
      tools: [...input.manifest.tools],
      mcpIntegrations: [...input.manifest.mcpIntegrations],
      credentialReferences: [...input.manifest.credentialReferences],
    },
    skills: input.manifest.skills.map((skill) => {
      const artifact = input.skillArtifacts.find(
        (candidate) => candidate.artifactHash === skill.artifactHash,
      )!;
      return {
        artifactHash: skill.artifactHash,
        name: skill.name,
        source: structuredClone(artifact.source),
        fileCount: artifact.files.length,
        totalBytes: artifact.files.reduce(
          (total, file) => total + file.sizeBytes,
          0,
        ),
      };
    }),
    declaredCapabilities,
    effectiveCapabilities,
    clippedCapabilities,
  };
}

function validateRelativeFilePath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error(`Harness file path "${path}" is unsafe.`);
  }
  const lower = `/${path.toLowerCase()}`;
  if (
    lower.includes("/.env") ||
    lower.includes("/credentials") ||
    lower.includes("/auth.json") ||
    lower.includes("/oauth") ||
    lower.includes("/token")
  ) {
    throw new Error(`Harness file path "${path}" is credential-bearing.`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Harness file path "${path}" is unsafe.`);
  }
  return path;
}

function validatePathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Harness ${label} "${value}" is unsafe.`);
  }
  return value;
}

function validateFileMode(mode: number): void {
  if (!Number.isInteger(mode) || !SAFE_FILE_MODES.has(mode)) {
    throw new Error(`Harness file mode "${mode}" is unsafe.`);
  }
}

function validateSafeProfileHomeFile(
  provider: "claude" | "codex",
  path: string,
  mode: number,
): void {
  const expected = provider === "claude" ? "CLAUDE.md" : "AGENTS.md";
  if (path !== expected || mode !== 0o644) {
    throw new Error(
      `Harness Profile home files for ${provider} are limited to ${expected} with mode 0644.`,
    );
  }
}

function addParentDirectories(directories: Set<string>, filePath: string): void {
  let current = filePath.slice(0, filePath.lastIndexOf("/"));
  while (current.startsWith("/tmp/aiw-harness/")) {
    directories.add(current);
    const parent = current.slice(0, current.lastIndexOf("/"));
    if (parent === current) break;
    current = parent;
  }
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
