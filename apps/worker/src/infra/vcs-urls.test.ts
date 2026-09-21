import { describe, expect, it } from "vitest";
import { buildVcsUrls } from "./vcs-urls.js";

describe("buildVcsUrls", () => {
  it("does not expose tokenized git URLs", () => {
    const urls = buildVcsUrls({
      host: "https://vcs.example.com",
      authUser: "provider-token",
      repoPath: "acme/api",
    });

    expect(urls).toEqual({
      cloneUrl: "https://vcs.example.com/acme/api.git",
      authUser: "provider-token",
    });
    expect(JSON.stringify(urls)).not.toContain("glpat-secret");
  });
});
