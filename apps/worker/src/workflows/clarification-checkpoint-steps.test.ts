import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileToBuffer = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({ readFileToBuffer })),
  },
}));
vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

import { verifyWorkspaceManifestStep } from "./clarification-checkpoint-steps.js";

const trustedManifest = {
  version: 1 as const,
  repositories: [{
    provider: "github" as const,
    repoPath: "acme/api",
    slug: "acme__api",
    localPath: "/vercel/sandbox",
    defaultBranch: "main",
    branchName: "blazebot/awt-1",
    selectedRationale: "ticket mentions api",
    preAgentSha: "trusted-sha",
  }],
};

describe("clarification workspace manifest verification", () => {
  beforeEach(() => {
    readFileToBuffer.mockReset();
  });

  it("accepts the sandbox copy when it still matches the manager-authored manifest", async () => {
    readFileToBuffer.mockResolvedValue(Buffer.from(JSON.stringify(trustedManifest)));

    await expect(
      verifyWorkspaceManifestStep("sbx-1", trustedManifest),
    ).resolves.toBeUndefined();
  });

  it("fails closed when an agent changed routing or baseline fields", async () => {
    readFileToBuffer.mockResolvedValue(Buffer.from(JSON.stringify({
      ...trustedManifest,
      repositories: [{
        ...trustedManifest.repositories[0],
        branchName: "attacker/branch",
        preAgentSha: "attacker-sha",
      }],
    })));

    await expect(
      verifyWorkspaceManifestStep("sbx-1", trustedManifest),
    ).rejects.toThrow("does not match the trusted provisioned manifest");
  });
});
