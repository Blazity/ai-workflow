import type {
  HarnessResolvedSkillArtifact,
  HarnessSkillSource,
} from "@shared/contracts";
import {
  HARNESS_SKILL_IMPORT_LIMITS,
  stableJson,
} from "@shared/contracts";
import { parseHarnessSkillMetadata } from "./manifest";
import { HarnessSkillArtifactIntegrityError } from "./artifact-error";
import {
  SkillValidationError,
  type SkillValidationResult,
} from "./validation";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type Sha256Digest = (bytes: Uint8Array) => string;

export interface HarnessSkillArtifactHashInput {
  name: string;
  description: string | null;
  source: HarnessSkillSource;
  files: HarnessResolvedSkillArtifact["files"];
}

export function hashHarnessSkillArtifact(
  artifact: HarnessSkillArtifactHashInput,
  digest: Sha256Digest,
): string {
  return digest(
    new TextEncoder().encode(stableJson(canonicalHashPayload(artifact))),
  );
}

export function assertExpectedArtifactHash(
  expected: string | undefined,
  actual: string,
): void {
  if (expected === undefined) return;
  if (!SHA256_PATTERN.test(expected) || expected !== actual) {
    throw new SkillValidationError(
      "artifact_drift",
      "Resolved skill artifact does not match the expected hash.",
    );
  }
}

export function verifyHarnessSkillArtifact(
  artifact: HarnessSkillArtifactHashInput & { artifactHash: string },
  digest: Sha256Digest,
): void {
  if (!SHA256_PATTERN.test(artifact.artifactHash)) {
    throw invalidArtifact("Skill artifact hash is invalid.");
  }
  if (
    artifact.files.length === 0 ||
    artifact.files.length > HARNESS_SKILL_IMPORT_LIMITS.maxFiles
  ) {
    throw invalidArtifact("Skill artifact file count is invalid.");
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of artifact.files) {
    if (!isSafeRelativePath(file.path)) {
      throw invalidArtifact("Skill artifact contains an unsafe file path.");
    }
    if (paths.has(file.path)) {
      throw invalidArtifact("Skill artifact contains a duplicate file path.");
    }
    paths.add(file.path);
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw invalidArtifact("Skill artifact contains an unsupported file mode.");
    }
    if (
      typeof file.contentBase64 !== "string" ||
      file.contentBase64.length % 4 !== 0 ||
      !BASE64_PATTERN.test(file.contentBase64)
    ) {
      throw invalidArtifact("Skill artifact contains invalid base64 content.");
    }
    const content = decodeBase64(file.contentBase64);
    if (encodeBase64(content) !== file.contentBase64) {
      throw invalidArtifact(
        "Skill artifact contains non-canonical base64 content.",
      );
    }
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > HARNESS_SKILL_IMPORT_LIMITS.maxFileBytes ||
      content.byteLength !== file.sizeBytes
    ) {
      throw invalidArtifact("Skill artifact file size is invalid.");
    }
    totalBytes += content.byteLength;
    if (totalBytes > HARNESS_SKILL_IMPORT_LIMITS.maxSkillBytes) {
      throw invalidArtifact("Skill artifact exceeds the total size limit.");
    }
    if (!SHA256_PATTERN.test(file.sha256) || digest(content) !== file.sha256) {
      throw invalidArtifact("Skill artifact file hash verification failed.");
    }
  }

  const skillDocument = artifact.files.find((file) => file.path === "SKILL.md");
  if (!skillDocument || skillDocument.mode !== 0o644) {
    throw invalidArtifact("Skill artifact requires a mode 0644 SKILL.md file.");
  }
  const metadata = parseHarnessSkillMetadata(
    decodeBase64(skillDocument.contentBase64),
  );
  if (
    metadata.name !== artifact.name ||
    metadata.description !== artifact.description
  ) {
    throw invalidArtifact("Skill artifact metadata does not match SKILL.md.");
  }
  if (hashHarnessSkillArtifact(artifact, digest) !== artifact.artifactHash) {
    throw invalidArtifact("Skill artifact aggregate hash verification failed.");
  }
}

export function validateHarnessSkillArtifact(
  artifact: HarnessSkillArtifactHashInput & { artifactHash: string },
  digest: Sha256Digest,
): SkillValidationResult<typeof artifact> {
  try {
    verifyHarnessSkillArtifact(artifact, digest);
    return { ok: true, value: artifact };
  } catch (error) {
    if (!(error instanceof SkillValidationError)) throw error;
    return { ok: false, error };
  }
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

function isSafeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw invalidArtifact("Skill artifact contains invalid base64 content.");
  }
  return Uint8Array.from(binary, (character) => character.codePointAt(0)!);
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

function invalidArtifact(reason: string): SkillValidationError {
  return new HarnessSkillArtifactIntegrityError(reason);
}
