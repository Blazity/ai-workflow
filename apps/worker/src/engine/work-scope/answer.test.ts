import { workScopeQuestionAnswerSchema } from "@shared/contracts";
import { describe, expect, it } from "vitest";
import { readRepositoryAnswer } from "./answer.js";

const catalogKeys = [
  "github:acme/api",
  "gitlab:acme/web",
  "gitlab:acme/platform/contracts",
  "github:acme/shared",
  "gitlab:acme/shared",
];

function read(answer: string, keys: string[] = catalogKeys, askedKeys: string[] = []) {
  const result = readRepositoryAnswer(answer, { catalogKeys: keys, askedKeys });
  // Whatever the reader returns is recorded as a trail event, so it must
  // always be a valid contract answer.
  expect(workScopeQuestionAnswerSchema.parse(result)).toEqual(result);
  return result;
}

describe("readRepositoryAnswer", () => {
  it("reads a refusal phrase as none", () => {
    expect(read("no more repositories")).toEqual({ kind: "none" });
  });

  it("reads `none, continue without it` as none", () => {
    expect(read("none, continue without it")).toEqual({ kind: "none" });
  });

  it("reads `None.` as none", () => {
    expect(read("None.")).toEqual({ kind: "none" });
  });

  it("reads `none needed` as unrecognised, because the refusal reader does not take a bare word after none", () => {
    expect(read("none needed")).toEqual({ kind: "unrecognised" });
  });

  it("reads `none, github:acme/api` as that repository, because an identity token outranks a refusal word", () => {
    expect(read("none, github:acme/api")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("resolves a provider scoped identity the catalog holds", () => {
    expect(read("Use github:acme/api please")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("resolves a bare path exactly one catalog key has", () => {
    expect(read("acme/platform/contracts")).toEqual({
      kind: "repositories",
      repositoryKeys: ["gitlab:acme/platform/contracts"],
    });
  });

  it("resolves a list of bare names, each the last path segment of exactly one catalog key", () => {
    expect(read("api, web")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api", "gitlab:acme/web"],
    });
  });

  it("does not read a sentence as a list of names", () => {
    expect(read("please use api")).toEqual({ kind: "unrecognised" });
  });

  it("does not resolve a bare name that is the last segment of two catalog keys", () => {
    expect(read("shared")).toEqual({ kind: "unrecognised" });
  });

  it("ignores bare names once the answer holds an identity token", () => {
    expect(read("github:acme/api, web")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("is unrecognised when any identity token does not resolve", () => {
    expect(read("github:acme/api github:acme/missing")).toEqual({ kind: "unrecognised" });
  });

  it("is unrecognised when more than eight distinct repositories resolve", () => {
    const keys = Array.from({ length: 9 }, (_, index) => `github:acme/repo-${index}`);
    expect(read(keys.join(" "), keys)).toEqual({ kind: "unrecognised" });
  });

  it("accepts exactly eight distinct repositories", () => {
    const keys = Array.from({ length: 8 }, (_, index) => `github:acme/repo-${index}`);
    expect(read(keys.join(" "), keys)).toEqual({ kind: "repositories", repositoryKeys: keys });
  });

  it("is unrecognised when nothing resolves", () => {
    expect(read("the code lives in the usual place")).toEqual({ kind: "unrecognised" });
  });

  it("keeps first mention order without duplicates", () => {
    expect(read("gitlab:acme/web, github:acme/api, https://gitlab.com/acme/web")).toEqual({
      kind: "repositories",
      repositoryKeys: ["gitlab:acme/web", "github:acme/api"],
    });
  });

  it("resolves a GitHub URL to the repository it points into", () => {
    expect(read("https://github.com/acme/api/blob/main/src/index.ts")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("resolves a key written in upper case", () => {
    expect(read("GITHUB:ACME/API")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("is unrecognised for a bare path present under both providers", () => {
    expect(read("acme/shared")).toEqual({ kind: "unrecognised" });
  });

  it("is unrecognised for `github:acme/api` when the catalog does not hold it", () => {
    expect(read("github:acme/api", ["gitlab:acme/api"])).toEqual({ kind: "unrecognised" });
  });

  it("reads `yes please` as the single repository the question asked about", () => {
    expect(read("yes please", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("reads `yes please` as unrecognised when the question asked about three repositories", () => {
    expect(
      read("yes please", catalogKeys, [
        "github:acme/api",
        "gitlab:acme/web",
        "github:acme/shared",
      ]),
    ).toEqual({ kind: "unrecognised" });
  });

  it("reads a refusal naming only the asked repository as unrecognised", () => {
    expect(read("none, we don't need acme/api", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "unrecognised",
    });
  });

  it("reads a refusal naming a different repository as that repository", () => {
    expect(read("none, use gitlab:acme/web", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "repositories",
      repositoryKeys: ["gitlab:acme/web"],
    });
  });

  it("reads `yes, but the other one` as unrecognised", () => {
    expect(read("yes, but the other one", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "unrecognised",
    });
  });
});
