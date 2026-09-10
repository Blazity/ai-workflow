import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHook = vi.fn(async () => ({ token: "ghs_minted-token", type: "token" as const, tokenType: "installation" as const }));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => mockHook),
}));

const mockGetAuthenticated = vi.fn();
const mockGetByUsername = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(function (this: any, opts: any) {
    this.opts = opts;
    this.apps = { getAuthenticated: mockGetAuthenticated };
    this.users = { getByUsername: mockGetByUsername };
  }),
}));

import {
  buildOctokit,
  getBotIdentity,
  getVcsToken,
  mintInstallationToken,
} from "./github-auth.js";

const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----";
const fakeAuth = {
  appId: 123,
  privateKeyBase64: Buffer.from(FAKE_PEM).toString("base64"),
  installationId: 456,
};

describe("github-auth", () => {
  beforeEach(async () => {
    mockHook.mockClear();
    mockGetAuthenticated.mockReset();
    mockGetByUsername.mockReset();
    const { createAppAuth } = await import("@octokit/auth-app");
    const { Octokit } = await import("@octokit/rest");
    vi.mocked(createAppAuth).mockClear();
    vi.mocked(Octokit).mockClear();
  });

  it("mintInstallationToken returns the token string from createAppAuth", async () => {
    const { createAppAuth } = await import("@octokit/auth-app");
    const token = await mintInstallationToken(fakeAuth);
    expect(token).toBe("ghs_minted-token");
    expect(createAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 123,
        privateKey: FAKE_PEM,
        installationId: 456,
      }),
    );
    expect(mockHook).toHaveBeenCalledWith({ type: "installation" });
  });

  it("getVcsToken preserves static GitLab tokens", async () => {
    await expect(getVcsToken({
      kind: "gitlab",
      token: "glpat-test",
    })).resolves.toBe("glpat-test");
  });

  it("getVcsToken mints GitHub installation tokens", async () => {
    await expect(getVcsToken({
      kind: "github",
      auth: fakeAuth,
    })).resolves.toBe("ghs_minted-token");
  });

  it("getBotIdentity returns App slug + numeric-id noreply email", async () => {
    mockGetAuthenticated.mockResolvedValueOnce({ data: { slug: "ai-workflow-blazity" } });
    mockGetByUsername.mockResolvedValueOnce({ data: { id: 9876543 } });
    const identity = await getBotIdentity(fakeAuth);
    expect(identity).toEqual({
      name: "ai-workflow-blazity[bot]",
      email: "9876543+ai-workflow-blazity[bot]@users.noreply.github.com",
    });
    expect(mockGetByUsername).toHaveBeenCalledWith({ username: "ai-workflow-blazity[bot]" });
  });

  it("getBotIdentity throws if /app response has no slug", async () => {
    mockGetAuthenticated.mockResolvedValueOnce({ data: {} });
    await expect(getBotIdentity(fakeAuth)).rejects.toThrow("missing `slug`");
  });

  it("buildOctokit constructs an Octokit with the App auth strategy and credentials", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { createAppAuth } = await import("@octokit/auth-app");
    buildOctokit(fakeAuth);
    expect(Octokit).toHaveBeenCalledWith(
      expect.objectContaining({
        authStrategy: createAppAuth,
        auth: expect.objectContaining({
          appId: 123,
          privateKey: FAKE_PEM,
          installationId: 456,
        }),
      }),
    );
  });
});
