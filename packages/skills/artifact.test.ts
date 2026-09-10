import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { HarnessSkillArtifactHashInput } from "./index";
import {
  assertExpectedArtifactHash,
  hashHarnessSkillArtifact,
  SkillValidationError,
  verifyHarnessSkillArtifact,
} from "./index";

const document = `---
name: review-rules
description: Client-specific review rules.
---

Review rules body.
`;

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function artifactFile(path: string, content: string) {
  const buffer = Buffer.from(content, "utf8");
  return {
    path,
    mode: 0o644,
    sizeBytes: buffer.byteLength,
    sha256: digest(buffer),
    contentBase64: buffer.toString("base64"),
  };
}

function githubArtifact(): HarnessSkillArtifactHashInput {
  return {
    name: "review-rules",
    description: "Client-specific review rules.",
    source: {
      owner: "blazity",
      repository: "ai-workflow",
      path: "skills/review-rules",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    files: [artifactFile("reference.md", "Reference notes.\n"), artifactFile("SKILL.md", document)],
  };
}

test("keeps the canonical GitHub artifact hash frozen", () => {
  assert.equal(
    hashHarnessSkillArtifact(githubArtifact(), digest),
    "f3c0c900c158fae7e8950cd63dbb6ce693917a4fed2b40fe014a814df2f7c691",
  );
});

test("keeps local identity source-sensitive and deterministic", () => {
  const github = githubArtifact();
  const local = {
    ...github,
    source: { path: "review-rules", contentSha256: "89ab".repeat(16) },
  };
  assert.equal(
    hashHarnessSkillArtifact(local, digest),
    "17c2b77840b1fc9a1b33543e0301638937cf860408efedb830b88898c21adabf",
  );
  assert.notEqual(
    hashHarnessSkillArtifact(local, digest),
    hashHarnessSkillArtifact(github, digest),
  );
  assert.equal(
    hashHarnessSkillArtifact(local, digest),
    hashHarnessSkillArtifact({ ...local, source: { ...local.source } }, digest),
  );
});

test("validates every file and the aggregate hash", () => {
  const artifact = githubArtifact();
  verifyHarnessSkillArtifact(
    { ...artifact, artifactHash: hashHarnessSkillArtifact(artifact, digest) },
    digest,
  );
});

test("reports expected-hash drift deterministically", () => {
  assert.throws(
    () => assertExpectedArtifactHash("f".repeat(64), "a".repeat(64)),
    (error: unknown) =>
      error instanceof SkillValidationError && error.code === "artifact_drift",
  );
});
