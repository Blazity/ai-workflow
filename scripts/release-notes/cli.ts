import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { collectRelease } from "./collect.js";
import { generateReleaseDraft } from "./generate.js";
import { parseVersion } from "./classify.js";
import { validateApprovedSourceRelease } from "./manifest.js";
import { validateRehearsalEvidence } from "./rehearsal.js";
import { extractShareableNotes, renderReleaseNotes } from "./render.js";
import {
  findUnbackportedDestinationCommits,
  synchronizeArturSnapshot,
} from "./sync.js";
import type {
  ApprovedSourceRelease,
  ReleaseCollection,
  ReleaseDraft,
  SyncResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

type CliCommandRunner = (command: string, args: string[]) => Promise<string>;

const runCommand: CliCommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args);
  return stdout;
};

const runArturCommand: CliCommandRunner = async (command, args) => {
  const token = process.env.ARTUR_GH_TOKEN;
  if (!token) return runCommand(command, args);
  const { stdout } = await execFileAsync(command, args, {
    env: { ...process.env, GH_TOKEN: token },
  });
  return stdout;
};

interface PrepareOptions {
  version: string;
  previousRef: string;
  targetRef: string;
  repository: string;
  output: string;
}

interface PrepareDeps {
  collect?: typeof collectRelease;
  generate?: typeof generateReleaseDraft;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function report(collection: ReleaseCollection, draft: ReleaseDraft): string {
  const list = (heading: string, prs: ReleaseCollection["included"]) =>
    `## ${heading}\n\n${prs.map((pr) => `- #${pr.number} — ${pr.title}`).join("\n") || "- None"}\n`;
  return `# Artur release preparation

- Previous commit: \`${collection.previousCommit}\`
- Target commit: \`${collection.targetCommit}\`
- Generator: \`${draft.generatedBy}\`
- Workflow run: ${process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "local"}

${list("Customer-facing changes", collection.included)}
${list("Internal changes", collection.internal)}
${list("Skipped changes", collection.skipped)}
## Warnings

${collection.warnings.map((warning) => `- ${warning}`).join("\n") || "- None"}
`;
}

export async function prepareRelease(
  options: PrepareOptions,
  deps: PrepareDeps = {},
): Promise<{ notesPath: string; reportPath: string }> {
  const version = parseVersion(options.version);
  const notesPath = path.join(options.output, "docs", "releases", "artur", `${version}.md`);
  const reportPath = path.join(options.output, ".release-notes", `artur-${version}-report.md`);
  if (await exists(notesPath)) throw new Error(`Release file already exists: ${notesPath}`);

  const collection = await (deps.collect ?? collectRelease)({
    repository: options.repository,
    previousRef: options.previousRef,
    targetRef: options.targetRef,
  });
  const draft = await (deps.generate ?? generateReleaseDraft)(collection);
  await mkdir(path.dirname(notesPath), { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(notesPath, renderReleaseNotes(collection, draft, version));
  await writeFile(reportPath, report(collection, draft));
  return { notesPath, reportPath };
}

export async function writeShareableRelease(notesPath: string, outputPath: string): Promise<void> {
  const markdown = await readFile(notesPath, "utf8");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, extractShareableNotes(markdown));
}

function arg(argv: string[], name: string, fallback = ""): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? "") : fallback;
}

function requiredArg(argv: string[], name: string): string {
  const value = arg(argv, name);
  if (!value) throw new Error(`Missing required argument: --${name}`);
  return value;
}

export async function latestPublishedSourceCommit(
  repository: string,
  run: CliCommandRunner = runArturCommand,
): Promise<string> {
  let raw: string;
  try {
    raw = await run("gh", ["release", "view", "--repo", repository, "--json", "tagName"]);
  } catch (error) {
    throw new Error(
      "Could not resolve the latest published Artur release; pass --previous-ref for the first release",
      { cause: error },
    );
  }
  const { tagName } = z.object({ tagName: z.string() }).parse(JSON.parse(raw));
  if (!tagName.startsWith("artur-v")) {
    throw new Error(`Latest Artur release has an unexpected tag: ${tagName}`);
  }
  const version = parseVersion(tagName.slice("artur-v".length));
  const manifest = z
    .object({
      version: z.string(),
      sourceRepository: z.literal("Blazity/ai-workflow"),
      sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
      destinationRepository: z.literal("Blazity/ai-workflow-arthur"),
    })
    .parse(
      JSON.parse(
        await run("gh", [
          "release",
          "download",
          tagName,
          "--repo",
          repository,
          "--pattern",
          "release-manifest.json",
          "--output",
          "-",
        ]),
      ),
    );
  if (manifest.version !== version) {
    throw new Error(`Published manifest version does not match ${tagName}`);
  }
  return manifest.sourceCommit;
}

async function prepareCommand(argv: string[]): Promise<unknown> {
  const version = parseVersion(requiredArg(argv, "version"));
  const previousRef =
    arg(argv, "previous-ref") ||
    (await latestPublishedSourceCommit("Blazity/ai-workflow-arthur"));
  return prepareRelease({
    version,
    previousRef,
    targetRef: arg(argv, "target-ref", "main"),
    repository: arg(argv, "repository", process.env.GITHUB_REPOSITORY ?? ""),
    output: path.resolve(arg(argv, "output", ".")),
  });
}

async function validateSourceCommand(
  argv: string[],
  validate: typeof validateApprovedSourceRelease,
): Promise<unknown> {
  const version = parseVersion(requiredArg(argv, "version"));
  const notesPath = path.resolve(
    arg(argv, "notes", path.join("docs", "releases", "artur", `${version}.md`)),
  );
  const outputPath = path.resolve(requiredArg(argv, "output"));
  const validation = await validate({
    version,
    markdown: await readFile(notesPath, "utf8"),
    mainRef: arg(argv, "main-ref", "main"),
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(validation, null, 2)}\n`);
  return validation;
}

async function validateRehearsalCommand(argv: string[]): Promise<unknown> {
  const version = parseVersion(requiredArg(argv, "version"));
  const rehearsalPath = path.resolve(
    arg(
      argv,
      "rehearsal",
      path.join("docs", "releases", "artur", "rehearsals", `${version}.json`),
    ),
  );
  return validateRehearsalEvidence({
    version,
    sourceCommit: requiredArg(argv, "source-commit"),
    rehearsalPath,
  });
}

async function shareableCommand(argv: string[]): Promise<unknown> {
  const version = parseVersion(requiredArg(argv, "version"));
  const notesPath = path.resolve(
    arg(argv, "notes", path.join("docs", "releases", "artur", `${version}.md`)),
  );
  const outputPath = path.resolve(requiredArg(argv, "output"));
  await writeShareableRelease(notesPath, outputPath);
  return { output: outputPath };
}

const approvedSourceSchema = z.object({
  version: z.string(),
  previousSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  targetSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  notesPath: z.string().min(1),
  releaseNotesPullRequest: z.number().int().positive(),
  releaseNotesApprovedBy: z.array(z.string().min(1)).min(1),
});

const acknowledgedDriftSchema = z.array(
  z.object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    reason: z.string().min(1),
  }),
);

interface CliDeps {
  validate?: typeof validateApprovedSourceRelease;
  findDrift?: typeof findUnbackportedDestinationCommits;
  sync?: typeof synchronizeArturSnapshot;
}

const releaseSlotSchema = z.object({
  repository: z.literal("Blazity/ai-workflow-arthur"),
  version: z.string(),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourcePullRequest: z.number().int().positive(),
});

export async function ensureArturReleaseSlot(
  rawInput: {
    repository: string;
    version: string;
    sourceCommit: string;
    sourcePullRequest: number;
  },
  run: CliCommandRunner = runArturCommand,
): Promise<void> {
  const input = releaseSlotSchema.parse(rawInput);
  const version = parseVersion(input.version);
  const tag = `artur-v${version}`;
  const branch = `release/artur-${version}`;
  const [releaseRaw, tagRefsRaw, branchRefsRaw, pullsRaw] = await Promise.all([
    run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${input.repository}/releases?per_page=100`,
    ]),
    run("gh", ["api", `repos/${input.repository}/git/matching-refs/tags/${tag}`]),
    run("gh", ["api", `repos/${input.repository}/git/matching-refs/heads/${branch}`]),
    run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${input.repository}/pulls?state=all&head=Blazity%3A${encodeURIComponent(branch)}&per_page=100`,
    ]),
  ]);
  const releases = z
    .array(z.array(z.object({ tag_name: z.string() })))
    .parse(JSON.parse(releaseRaw))
    .flat();
  const refs = z.array(z.object({ ref: z.string() }));
  const tagRefs = refs.parse(JSON.parse(tagRefsRaw));
  const branchRefs = refs.parse(JSON.parse(branchRefsRaw));
  if (releases.some((release) => release.tag_name === tag) || tagRefs.length > 0) {
    throw new Error(`Artur release ${tag} is already published or reserved by a tag`);
  }
  const pulls = z
    .array(
      z.array(
        z.object({
          number: z.number().int().positive(),
          state: z.string(),
          body: z.string().nullable(),
          base: z.object({ ref: z.string() }),
          head: z.object({ ref: z.string() }),
        }),
      ),
    )
    .parse(JSON.parse(pullsRaw))
    .flat();
  if (pulls.length === 0) {
    if (branchRefs.length > 0) {
      throw new Error(`Artur release branch ${branch} exists without a matching pull request`);
    }
    return;
  }
  if (pulls.length !== 1) throw new Error(`Artur release ${version} has multiple pull requests`);
  const pull = pulls[0];
  if (pull.state !== "open" || pull.base.ref !== "main" || pull.head.ref !== branch) {
    throw new Error(`Artur release ${version} already has a non-reusable pull request`);
  }
  if (branchRefs.length !== 1) throw new Error(`Open Artur pull request has no unique release branch`);
  const match = /<!-- artur-release\s*\n([\s\S]*?)\n-->/.exec(pull.body ?? "");
  if (!match) throw new Error(`Open Artur pull request #${pull.number} has no release marker`);
  const marker = z
    .object({
      version: z.string(),
      sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
      sourcePullRequest: z.number().int().positive(),
    })
    .strict()
    .parse(JSON.parse(match[1]));
  if (
    marker.version !== version ||
    marker.sourceCommit !== input.sourceCommit ||
    marker.sourcePullRequest !== input.sourcePullRequest
  ) {
    throw new Error(`Open Artur pull request #${pull.number} targets different release inputs`);
  }
}

async function guardArturCommand(argv: string[]): Promise<unknown> {
  const version = parseVersion(requiredArg(argv, "version"));
  const approval = approvedSourceSchema.parse(
    JSON.parse(await readFile(path.resolve(requiredArg(argv, "approval")), "utf8")),
  );
  if (approval.version !== version) {
    throw new Error(`Approved release ${approval.version} does not match ${version}`);
  }
  await ensureArturReleaseSlot({
    repository: requiredArg(argv, "repository"),
    version,
    sourceCommit: approval.targetSourceCommit,
    sourcePullRequest: approval.releaseNotesPullRequest,
  });
  return { version, available: true };
}

async function readAcknowledgedDrift(sourceMainDir: string): Promise<Set<string>> {
  const file = path.join(sourceMainDir, "scripts/release-notes/acknowledged-drift.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  return new Set(acknowledgedDriftSchema.parse(JSON.parse(raw)).map((entry) => entry.commit));
}

async function syncArturCommand(argv: string[], deps: CliDeps): Promise<SyncResult> {
  const version = parseVersion(requiredArg(argv, "version"));
  const approval = approvedSourceSchema.parse(
    JSON.parse(await readFile(path.resolve(requiredArg(argv, "approval")), "utf8")),
  ) as ApprovedSourceRelease;
  if (approval.version !== version) {
    throw new Error(`Approved release ${approval.version} does not match ${version}`);
  }
  const sourceMainDir = path.resolve(requiredArg(argv, "source-main"));
  const sourceSnapshotDir = path.resolve(requiredArg(argv, "source-snapshot"));
  const destinationDir = path.resolve(requiredArg(argv, "destination"));
  const previousDestinationRef = requiredArg(argv, "previous-destination-ref");
  const foundDrift = await (deps.findDrift ?? findUnbackportedDestinationCommits)({
    sourceSnapshotDir,
    destinationDir,
    previousSourceCommit: approval.previousSourceCommit,
    targetSourceCommit: approval.targetSourceCommit,
    previousDestinationRef,
  });
  const acknowledgedDrift = await readAcknowledgedDrift(sourceMainDir);
  const acknowledged = foundDrift.filter((commit) => acknowledgedDrift.has(commit));
  const driftCommits = foundDrift.filter((commit) => !acknowledgedDrift.has(commit));
  if (driftCommits.length > 0) {
    throw new Error(
      `Artur contains application commits that are not backported to the selected source snapshot: ${driftCommits.join(", ")}`,
    );
  }
  const result = await (deps.sync ?? synchronizeArturSnapshot)({
    version,
    sourceMainDir,
    sourceSnapshotDir,
    destinationDir,
    approved: approval,
  });
  const outputPath = path.resolve(requiredArg(argv, "output"));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const record: Record<string, unknown> = { ...result, driftCommits };
  if (acknowledged.length > 0) record.acknowledgedDrift = acknowledged;
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...result, driftCommits };
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<unknown> {
  const commands: Record<string, () => Promise<unknown>> = {
    prepare: () => prepareCommand(argv),
    "guard-artur": () => guardArturCommand(argv),
    "validate-source": () =>
      validateSourceCommand(argv, deps.validate ?? validateApprovedSourceRelease),
    "validate-rehearsal": () => validateRehearsalCommand(argv),
    "sync-artur": () => syncArturCommand(argv, deps),
    shareable: () => shareableCommand(argv),
  };
  const command = argv[0] ?? "";
  const execute = commands[command];
  if (!execute) {
    throw new Error(
      "Usage: pnpm release-notes <prepare|guard-artur|validate-source|validate-rehearsal|sync-artur|shareable> [options]",
    );
  }
  return execute();
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
