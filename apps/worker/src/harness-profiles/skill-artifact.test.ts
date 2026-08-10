import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HarnessSkillArtifactHashInput } from "./skill-artifact.js";
import { hashHarnessSkillArtifact } from "./skill-artifact.js";

const SKILL_DOCUMENT = `---
name: review-rules
description: Client-specific review rules.
---

Review rules body.
`;

const REFERENCE_DOCUMENT = "Reference notes.\n";

function artifactFile(
  path: string,
  content: string,
): HarnessSkillArtifactHashInput["files"][number] {
  const buffer = Buffer.from(content, "utf8");
  return {
    path,
    mode: 0o644,
    sizeBytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    contentBase64: buffer.toString("base64"),
  };
}

function artifactFiles(): HarnessSkillArtifactHashInput["files"] {
  return [
    artifactFile("reference.md", REFERENCE_DOCUMENT),
    artifactFile("SKILL.md", SKILL_DOCUMENT),
  ];
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
    files: artifactFiles(),
  };
}

describe("harness skill artifact hashing", () => {
  it("keeps the canonical hash of a GitHub-sourced artifact frozen", () => {
    expect(hashHarnessSkillArtifact(githubArtifact())).toBe(
      // Recorded from the GitHub-only contract that shipped before local
      // skills existed. Profiles pin skills by this hash, so a change here
      // unpins every artifact already stored in production.
      "f3c0c900c158fae7e8950cd63dbb6ce693917a4fed2b40fe014a814df2f7c691",
    );
  });

  it("gives a deployment-local artifact an identity of its own", () => {
    const local: HarnessSkillArtifactHashInput = {
      name: "review-rules",
      description: "Client-specific review rules.",
      source: {
        path: "review-rules",
        contentSha256:
          "89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab",
      },
      files: artifactFiles(),
    };

    // Compared against a hash computed here rather than against the frozen
    // literal above: the same files under a different source must hash apart,
    // and pinning that to a literal would let this stop proving it the day the
    // fixture changes.
    expect(hashHarnessSkillArtifact(local)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashHarnessSkillArtifact(local)).not.toBe(
      hashHarnessSkillArtifact(githubArtifact()),
    );
  });

  it("hashes two deployment-local artifacts with the same path and content alike", () => {
    const source = {
      path: "review-rules",
      contentSha256:
        "89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab89ab",
    };
    const base: HarnessSkillArtifactHashInput = {
      name: "review-rules",
      description: "Client-specific review rules.",
      source,
      files: artifactFiles(),
    };

    expect(hashHarnessSkillArtifact(base)).toBe(
      hashHarnessSkillArtifact({ ...base, source: { ...source } }),
    );
  });
});
