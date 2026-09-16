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

// What the question looks like when the bot asks it, so a test can send it
// back the way Jira's quote button does: the whole document flattened to text,
// with no marker left to say it was a quote.
const QUESTION = [
  "This ticket may also touch github:acme/api, which this deployment does not hold.",
  "Reply with the repositories to attach, or none.",
].join("\n");

function read(
  answer: string,
  keys: string[] = catalogKeys,
  askedKeys: string[] = [],
  askedQuestions: string[] = [],
) {
  const result = readRepositoryAnswer(answer, {
    catalogKeys: keys,
    askedKeys,
    askedQuestions,
  });
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

  it.each([`${QUESTION}\n\nno`, `${QUESTION}\nno`])(
    "asks again when the question is quoted back with a no under it: %o",
    (answer) => {
      // Jira's quote button sends our own repository key back inside the
      // answer, and the adapter flattens it with no quote marker, so without
      // the questions we asked this reads as the person selecting it.
      expect(read(answer, catalogKeys, ["github:acme/api"], [QUESTION])).toEqual({
        kind: "unrecognised",
      });
    },
  );

  it("reads only the repository a person typed under the question they quoted", () => {
    expect(
      read(`${QUESTION}\n\nuse gitlab:acme/web`, catalogKeys, ["github:acme/api"], [QUESTION]),
    ).toEqual({ kind: "repositories", repositoryKeys: ["gitlab:acme/web"] });
  });

  it("reads a question a person retyped in their own words as their answer", () => {
    expect(
      read("i think github:acme/api", catalogKeys, ["github:acme/api"], [QUESTION]),
    ).toEqual({ kind: "repositories", repositoryKeys: ["github:acme/api"] });
  });

  it.each(["✅", "👍", "?", ".", "", "   "])(
    "asks again for %o, because a reaction says the question was read and not what was decided",
    (answer) => {
      expect(read(answer, catalogKeys, ["github:acme/api"])).toEqual({
        kind: "unrecognised",
      });
    },
  );

  it.each([
    "no, we do not need acme/api",
    "we are not touching acme/api this time",
    "leave acme/api out",
    "nie, acme/api nie jest potrzebne",
  ])("asks again for %o, because a no beside the repository we asked about is a contradiction", (answer) => {
    expect(read(answer, catalogKeys, ["github:acme/api"])).toEqual({ kind: "unrecognised" });
  });

  it("reads `not acme/api, use acme/web` as the web repository alone", () => {
    expect(read("not acme/api, use acme/web", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "repositories",
      repositoryKeys: ["gitlab:acme/web"],
    });
  });

  it.each([
    "continue without it",
    "none of these",
    "none of them",
    "not needed",
    "no need",
    "skip it",
    "nope",
    "nie",
    "żaden",
    "zaden z nich",
    "żadne z nich",
    "bez tego",
  ])("reads %o as no repository at all", (answer) => {
    expect(read(answer, catalogKeys, ["github:acme/api"])).toEqual({ kind: "none" });
  });

  it.each(["tak", "tak, dodaj", "dodaj", "uzyj", "użyj"])(
    "reads %o as the single repository the question asked about",
    (answer) => {
      expect(read(answer, catalogKeys, ["github:acme/api"])).toEqual({
        kind: "repositories",
        repositoryKeys: ["github:acme/api"],
      });
    },
  );

  it("ignores a ticket link beside the repositories an answer names", () => {
    expect(read("acme/api, acme/web, see https://blazity.atlassian.net/browse/AWP-9")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api", "gitlab:acme/web"],
    });
  });

  it("ignores a ticket link at the end of a list of bare names", () => {
    expect(read("api, web, https://blazity.atlassian.net/browse/AWP-9")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api", "gitlab:acme/web"],
    });
  });

  it("resolves a link on a host the provider list does not name when the catalog holds its path", () => {
    // A company GitLab is not gitlab.com, and a link there is how a person
    // sends the repository that has no short name they trust. Dropping it would
    // start a run missing half of what they asked for and say nothing.
    expect(read("acme/api, https://gitlab.acme.com/acme/platform/contracts")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api", "gitlab:acme/platform/contracts"],
    });
  });

  it("ignores a ticket link on that same host, whose path no repository has", () => {
    expect(read("acme/api, https://gitlab.acme.com/browse/AWP-9")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("still asks again when a word of prose stands between bare names and a ticket link", () => {
    // The link no longer poisons the answer, but "see" is prose, and a list of
    // bare names is all or nothing: guessing which half of a sentence was a
    // repository is the guess this reader does not make.
    expect(read("api, web, see https://blazity.atlassian.net/browse/AWP-9")).toEqual({
      kind: "unrecognised",
    });
  });

  it("is unrecognised when the answer names a repository nothing holds", () => {
    expect(read("api and the old acme/legacy-thing")).toEqual({ kind: "unrecognised" });
  });
});
