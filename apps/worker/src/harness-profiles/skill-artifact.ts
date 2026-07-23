import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  HarnessResolvedSkillArtifact,
  HarnessSkillSource,
} from "@shared/contracts";
import { HARNESS_SKILL_IMPORT_LIMITS } from "@shared/contracts";
import { parse as parseYaml } from "yaml";
import { stableJson } from "./manifest.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface HarnessSkillArtifactHashInput {
  name: string;
  description: string | null;
  source: HarnessSkillSource;
  files: HarnessResolvedSkillArtifact["files"];
}

export class HarnessSkillArtifactIntegrityError extends Error {}

export function hashHarnessSkillArtifact(
  artifact: HarnessSkillArtifactHashInput,
): string {
  return createHash("sha256")
    .update(stableJson(canonicalHashPayload(artifact)))
    .digest("hex");
}

export function verifyHarnessSkillArtifact(
  artifact: HarnessSkillArtifactHashInput & { artifactHash: string },
): void {
  if (!SHA256_PATTERN.test(artifact.artifactHash)) {
    throw new HarnessSkillArtifactIntegrityError(
      "Skill artifact hash is invalid.",
    );
  }
  if (
    artifact.files.length < 1 ||
    artifact.files.length > HARNESS_SKILL_IMPORT_LIMITS.maxFiles
  ) {
    throw new HarnessSkillArtifactIntegrityError(
      "Skill artifact file count is invalid.",
    );
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of artifact.files) {
    if (
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      posix.normalize(file.path) !== file.path ||
      file.path.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact contains an unsafe file path.",
      );
    }
    if (paths.has(file.path)) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact contains a duplicate file path.",
      );
    }
    paths.add(file.path);
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact contains an unsupported file mode.",
      );
    }
    if (
      typeof file.contentBase64 !== "string" ||
      file.contentBase64.length % 4 !== 0 ||
      !BASE64_PATTERN.test(file.contentBase64)
    ) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact contains invalid base64 content.",
      );
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.toString("base64") !== file.contentBase64) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact contains non-canonical base64 content.",
      );
    }
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > HARNESS_SKILL_IMPORT_LIMITS.maxFileBytes ||
      content.byteLength !== file.sizeBytes
    ) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact file size is invalid.",
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > HARNESS_SKILL_IMPORT_LIMITS.maxSkillBytes) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact exceeds the total size limit.",
      );
    }
    if (
      !SHA256_PATTERN.test(file.sha256) ||
      createHash("sha256").update(content).digest("hex") !== file.sha256
    ) {
      throw new HarnessSkillArtifactIntegrityError(
        "Skill artifact file hash verification failed.",
      );
    }
  }

  const skillDocument = artifact.files.find(
    (file) => file.path === "SKILL.md",
  );
  if (!skillDocument || skillDocument.mode !== 0o644) {
    throw new HarnessSkillArtifactIntegrityError(
      "Skill artifact requires a mode 0644 SKILL.md file.",
    );
  }
  const metadata = parseHarnessSkillMetadata(
    Buffer.from(skillDocument.contentBase64, "base64"),
  );
  if (
    metadata.name !== artifact.name ||
    metadata.description !== artifact.description
  ) {
    throw new HarnessSkillArtifactIntegrityError(
      "Skill artifact metadata does not match SKILL.md.",
    );
  }
  if (hashHarnessSkillArtifact(artifact) !== artifact.artifactHash) {
    throw new HarnessSkillArtifactIntegrityError(
      "Skill artifact aggregate hash verification failed.",
    );
  }
}

export function parseHarnessSkillMetadata(content: Buffer): {
  name: string;
  description: string;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new HarnessSkillArtifactIntegrityError(
      "SKILL.md is not valid UTF-8.",
    );
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    throw new HarnessSkillArtifactIntegrityError(
      "SKILL.md requires YAML front matter.",
    );
  }
  let frontMatter: unknown;
  try {
    frontMatter = parseYaml(match[1]!);
  } catch {
    throw new HarnessSkillArtifactIntegrityError(
      "SKILL.md contains malformed YAML.",
    );
  }
  if (
    !frontMatter ||
    typeof frontMatter !== "object" ||
    Array.isArray(frontMatter)
  ) {
    throw new HarnessSkillArtifactIntegrityError(
      "SKILL.md front matter must be an object.",
    );
  }
  const record = frontMatter as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    !SKILL_NAME_PATTERN.test(record.name)
  ) {
    throw new HarnessSkillArtifactIntegrityError(
      "SKILL.md has an invalid name.",
    );
  }
  if (
    typeof record.description !== "string" ||
    record.description.trim() !== record.description ||
    record.description.length < 1 ||
    record.description.length > 1_024
  ) {
    throw new HarnessSkillArtifactIntegrityError(
      "SKILL.md has an invalid description.",
    );
  }
  return { name: record.name, description: record.description };
}

function canonicalHashPayload(artifact: HarnessSkillArtifactHashInput) {
  return {
    source: artifact.source,
    name: artifact.name,
    description: artifact.description,
    files: [...artifact.files]
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      )
      .map((file) => ({
        path: file.path,
        mode: file.mode,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        contentBase64: file.contentBase64,
      })),
  };
}
