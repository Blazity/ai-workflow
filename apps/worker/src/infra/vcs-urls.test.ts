import { describe, expect, it } from "vitest";
import { buildVcsUrls } from "./vcs-urls.js";

describe("buildVcsUrls", () => {
  it("does not expose tokenized git URLs", () => {
    const urls = buildVcsUrls({ kind: "gitlab", host: "https://gitlab.example.com", repoPath: "acme/api" });

    expect(urls).toEqual({
      cloneUrl: "https://gitlab.example.com/acme/api.git",
      authUser: "oauth2",
    });
    expect(JSON.stringify(urls)).not.toContain("glpat-secret");
  });
});
