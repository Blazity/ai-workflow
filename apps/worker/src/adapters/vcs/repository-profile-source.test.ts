import { describe, expect, it } from "vitest";
import {
  boundRepositoryProfileBundle,
  pickRepositoryProfileReadme,
  REPOSITORY_PROFILE_TRUNCATION_MARKER,
  type RepositoryProfileBundle,
} from "./repository-profile-source.js";

function bundle(overrides: Partial<RepositoryProfileBundle> = {}): RepositoryProfileBundle {
  return {
    provider: "github",
    repoPath: "acme/api",
    defaultBranch: "main",
    description: "",
    readme: "",
    manifests: [],
    lockfiles: [],
    ciDefinitions: [],
    languages: [],
    truncated: [],
    ...overrides,
  };
}

describe("boundRepositoryProfileBundle", () => {
  it("leaves a bundle that already fits exactly as it is", () => {
    const small = bundle({ readme: "# api", manifests: [{ path: "package.json", content: "{}" }] });
    expect(boundRepositoryProfileBundle(small, 1_000)).toEqual(small);
  });

  it("cuts the README first and says how much it kept", () => {
    const bounded = boundRepositoryProfileBundle(
      bundle({
        readme: "r".repeat(400),
        ciDefinitions: [{ path: "ci.yml", content: "c".repeat(100) }],
      }),
      300,
    );

    expect(bounded.ciDefinitions[0]?.content).toBe("c".repeat(100));
    expect(bounded.readme.endsWith(REPOSITORY_PROFILE_TRUNCATION_MARKER)).toBe(true);
    expect(bounded.truncated).toEqual([
      { what: "readme", originalLength: 400, keptLength: bounded.readme.length - REPOSITORY_PROFILE_TRUNCATION_MARKER.length },
    ]);
  });

  it("reaches the CI definitions only once the README is gone, and never the manifests first", () => {
    const bounded = boundRepositoryProfileBundle(
      bundle({
        readme: "r".repeat(200),
        ciDefinitions: [{ path: "ci.yml", content: "c".repeat(400) }],
        manifests: [{ path: "package.json", content: "m".repeat(100) }],
      }),
      200,
    );

    expect(bounded.readme).toBe("");
    expect(bounded.manifests[0]?.content).toBe("m".repeat(100));
    expect(bounded.ciDefinitions[0]?.content.endsWith(REPOSITORY_PROFILE_TRUNCATION_MARKER)).toBe(
      true,
    );
    expect(bounded.truncated.map((cut) => cut.what)).toEqual(["readme", "ci:ci.yml"]);
  });

  it("keeps the bundle under the bound even when everything has to go", () => {
    const bounded = boundRepositoryProfileBundle(
      bundle({
        readme: "r".repeat(500),
        ciDefinitions: [{ path: "ci.yml", content: "c".repeat(500) }],
        manifests: [{ path: "package.json", content: "m".repeat(500) }],
      }),
      60,
    );

    const length =
      bounded.readme.length +
      bounded.manifests.reduce((sum, file) => sum + file.path.length + file.content.length, 0) +
      bounded.ciDefinitions.reduce((sum, file) => sum + file.path.length + file.content.length, 0) +
      bounded.provider.length +
      bounded.repoPath.length +
      bounded.defaultBranch.length;
    expect(length).toBeLessThanOrEqual(60);
    // The paths survive: that a repository HAS a package.json is a fact worth
    // keeping even when none of its bytes fit.
    expect(bounded.manifests[0]?.path).toBe("package.json");
    expect(bounded.truncated).toHaveLength(3);
  });
});

describe("pickRepositoryProfileReadme", () => {
  it("prefers the markdown README when a repository carries more than one", () => {
    expect(pickRepositoryProfileReadme(["README", "README.md"])).toBe("README.md");
  });

  it("answers null when a repository has none", () => {
    expect(pickRepositoryProfileReadme(["package.json"])).toBe(null);
  });
});
