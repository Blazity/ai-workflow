import { workScopeQuestionAnswerSchema } from "@shared/contracts";
import { describe, expect, it } from "vitest";
import { answerSaysNoAndNamesARepository, readRepositoryAnswer } from "./answer.js";
// The real comment builder, so a test can send the question back in the form a
// person was actually shown rather than the form we stored.
import { formatClarificationQuestionsComment } from "../support/clarification-comment-format.js";
// The real recovery sentence, so this file cannot drift into holding a stale
// copy of a production string and proving something about nothing.
import { exclusionRecoveryNotes } from "./context.js";

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

// The same question with every word of negation taken out of it. QUESTION says
// "does not hold" and "or none", so a copy of it quoted back reads as a refusal
// whatever the drop does, and a test built on it proves the redirect rule
// rather than the drop.
const PLAIN_QUESTION = [
  "This ticket may also touch github:acme/api, which this deployment holds.",
  "Reply with every repository this work should attach.",
].join("\n");

/** The question as the ticket comment actually posts it: numbered, published. */
function postedQuestion(question: string = QUESTION): string {
  const block = formatClarificationQuestionsComment({
    questions: [question],
    suggestedAnswers: null,
    dashboardUrl: "https://dashboard.example/tickets/AWT-1",
    aiColumnName: "Ai",
    expiresAtIso: null,
  })
    .split("\n\n")
    .find((section) => section.startsWith("1. "));
  if (!block) throw new Error("the questions comment no longer numbers its questions");
  return block;
}

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

  // Round 4, the owner's rule. A reply that says no about anything records
  // nothing, and the words beside the no change that for no phrasing: working
  // out what a no attached to is the guess every defect in this feature came
  // out of. Both of these are unreadable, and both people are told the same
  // thing, which is to name only the repositories to use.
  it.each(["none, github:acme/api", "none, use github:acme/api"])(
    "reads %o as unrecognised, because it says no and names a repository",
    (answer) => {
      expect(read(answer)).toEqual({ kind: "unrecognised" });
    },
  );

  // AWP-221 on production, 2026-09-18. A person answered the which-of-these
  // question with one comment: the word "no", a line break, "none of these".
  // Read as one string it matched no phrase in the list, so the reply that said
  // the same thing twice was less readable than either half of it alone, and the
  // comment back told that person to answer "none" the next time the question
  // was asked. They had just written it. Every phrase here is a refusal and none
  // of them names anything else, so the reply declines every repository the
  // question listed (A17b).
  it.each(["no\nnone of these", "no, none of these", "nope\nnone", "none of these"])(
    "reads %o as none, because every phrase in it is a refusal",
    (answer) => {
      expect(read(answer)).toEqual({ kind: "none" });
    },
  );

  // The other half of that rule, and it does not move: a phrase that names a
  // repository, or one carrying a word this reader would have to interpret,
  // leaves the whole reply unreadable however plain the refusal beside it is.
  it.each([
    "no\nnone of these\ngithub:acme/api",
    "no, use github:acme/api",
    "no\nnone of these, but check with the team first",
  ])("reads %o as unrecognised, because a phrase in it is not a refusal", (answer) => {
    expect(read(answer)).toEqual({ kind: "unrecognised" });
  });

  // The repeat question these four used to cost. A person who wrote "none of the
  // above" under a question listing four repositories was read as naming
  // nothing, so the identical question came back and they answered it twice; the
  // same for "neither". Each refuses a SET rather than a subject, so each
  // declines the whole list exactly as "none of these" does (A17d).
  it.each(["neither", "neither of them", "neither of these", "none of the above"])(
    "reads %o as declining the list instead of asking again",
    (answer) => {
      const four = [
        "github:acme/api",
        "gitlab:acme/web",
        "github:acme/shared",
        "gitlab:acme/shared",
      ];
      expect(read(answer, catalogKeys, four)).toEqual({ kind: "none" });
      // And the punctuation and capitals people actually type around them.
      expect(read(`${answer.replace(/^n/, "N")}.`, catalogKeys, four)).toEqual({ kind: "none" });
    },
  );

  // The owner's ruling of 2026-09-18: a refusal phrase declines only what it can
  // be about. "continue without it" refuses ONE repository, which is what the
  // in-run question asks about and offers those words for, and what a question
  // listing four contradicts. Four permanent exclusions off a sentence about one
  // repository is the decision nobody made; being asked again is the cheap
  // failure beside it (rule 1). The gate is the question's shape, so the
  // dashboard and the ticket read these words identically.
  it("reads a refusal about one repository as none when the question asked about one", () => {
    expect(read("no, continue without it", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "none",
    });
    expect(read("continue without it", catalogKeys, ["github:acme/api"])).toEqual({ kind: "none" });
  });

  it("reads the same words as unrecognised when the question listed four repositories", () => {
    const four = ["github:acme/api", "gitlab:acme/web", "github:acme/shared", "gitlab:acme/shared"];
    expect(read("no, continue without it", catalogKeys, four)).toEqual({ kind: "unrecognised" });
    expect(read("continue without it", catalogKeys, four)).toEqual({ kind: "unrecognised" });
    // A reply refusing the whole list still declines it, which is the half of
    // the ruling that must not move: the phrase, not the count of phrases, is
    // what decides.
    expect(read("no\nnone of these", catalogKeys, four)).toEqual({ kind: "none" });
    expect(read("none of these", catalogKeys, four)).toEqual({ kind: "none" });
    // And a word with no subject in it is not weighed against the list at all:
    // threaded to the question it takes that question's own subject, and which
    // channels may thread it is A8 and A9.
    expect(read("no", catalogKeys, four)).toEqual({ kind: "none" });
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

  // Round 4. This used to be read as a redirect: no to the asked repository,
  // yes to the named one. It names a repository, so the refusal is no longer a
  // plain one, and nothing here decides which half the person meant to stand.
  it("reads a refusal naming a different repository as unrecognised", () => {
    expect(read("none, use gitlab:acme/web", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "unrecognised",
    });
  });

  it("reads `yes, but the other one` as unrecognised", () => {
    expect(read("yes, but the other one", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "unrecognised",
    });
  });

  it.each([`${QUESTION}\n\nno`, `${QUESTION}\nno`, `> ${QUESTION}\nno`])(
    "declines what the question listed when it is quoted back with a no under it: %o",
    (answer) => {
      // Jira's quote button sends our own repository key back inside the
      // answer, and the adapter flattens it with no quote marker, so without
      // the questions we asked this reads as the person selecting it.
      //
      // Round 4, and this test changed meaning with it. Once our words are out,
      // what the person wrote is the word "no", and this reply is threaded to
      // the question it answers, so it declines what that question listed
      // rather than costing them another round. Our own key is still not
      // recorded as their choice, which is what this test is here for.
      expect(read(answer, catalogKeys, ["github:acme/api"], [QUESTION])).toEqual({
        kind: "none",
      });
    },
  );

  it.each([
    ["the dashboard shows it, word for word", () => PLAIN_QUESTION],
    ["the ticket posted it, numbered", () => postedQuestion(PLAIN_QUESTION)],
    [
      "the ticket composed it from comments, author in front",
      () => `Filip Maszota: ${postedQuestion(PLAIN_QUESTION)}`,
    ],
  ])(
    "reads only the repository a person typed under the question, quoted as %s",
    (_form, quoted) => {
      // The stored question is not what anybody sees, and this question carries
      // no negation, so nothing behind the drop can rescue it: whether our own
      // key is recorded as this person's choice is decided by the drop alone.
      expect(
        read(
          `${quoted()}\n\nuse gitlab:acme/web`,
          catalogKeys,
          ["github:acme/api"],
          [PLAIN_QUESTION],
        ),
      ).toEqual({ kind: "repositories", repositoryKeys: ["gitlab:acme/web"] });
    },
  );

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

  // Round 4. The clearest redirect anybody writes, and it is still unreadable:
  // the reader that could take web out of this is the reader that took billing
  // out of "do not touch github:acme/billing", and one of those two is a
  // decision recorded against somebody who refused it.
  it("reads `not acme/api, use acme/web` as unrecognised", () => {
    expect(read("not acme/api, use acme/web", catalogKeys, ["github:acme/api"])).toEqual({
      kind: "unrecognised",
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

  // Row A11b of the behaviour map, and round 5 changed what it costs.
  //
  // This used to pin a trade we had chosen: our own comments quoted back stayed
  // in the text the refusal rules read, so a person quoting the recovery
  // sentence, which carries "is not final", and naming a repository under it
  // got another round. That was cheap next to reading our own words as their
  // no, and it was a cost we took deliberately.
  //
  // It is not a cost worth taking now that the quote is marked. What a person
  // QUOTED comes out of their words on every channel that marks it, so the
  // answer under the quote is read, and the reply that is most obviously a yes
  // finally works. Both forms are pinned: the quote button's marker, and the
  // Jira wiki "bq." a project on the old editor writes.
  it.each([
    ["a mail client or the rich editor", (line: string) => `> ${line}`],
    ["the Jira wiki editor", (line: string) => `bq. ${line}`],
  ])("reads the repository named under our recovery sentence quoted by %s", (_channel, quote) => {
    const [recovery] = exclusionRecoveryNotes(["github:acme/api"], {
      enabledKeys: ["github:acme/api"],
      unusableKeys: null,
    });
    // The control: without a word of negation in the quoted sentence there
    // would be nothing here to pin.
    expect(recovery).toContain("is not final");

    expect(
      read(
        `${quote(recovery!)}\n\ngithub:acme/api`,
        catalogKeys,
        ["github:acme/api"],
        [PLAIN_QUESTION],
      ),
    ).toEqual({ kind: "repositories", repositoryKeys: ["github:acme/api"] });
  });

  // And the cost that is still real, because nothing marks it: a person who
  // retypes one of our sentences instead of quoting it is read as writing it,
  // so a negation in it is theirs. Asking again is the cheap half of rule 1.
  it("asks again when a person retypes our recovery sentence with no quote marker", () => {
    const [recovery] = exclusionRecoveryNotes(["github:acme/api"], {
      enabledKeys: ["github:acme/api"],
      unusableKeys: null,
    });

    expect(
      read(`${recovery}\n\ngithub:acme/api`, catalogKeys, ["github:acme/api"], [PLAIN_QUESTION]),
    ).toEqual({ kind: "unrecognised" });
  });
});

// Joint gate round 3, R1 widened. A no never becomes a selection of the
// repository it sits beside. Each phrasing here is one a person could plausibly
// write, and each used to record billing (or web) in their name.
describe("readRepositoryAnswer and a no beside a named repository", () => {
  const CATALOG = ["infra", "web", "api", "docs", "billing"].map((name) => `github:acme/${name}`);
  const readAsked = (answer: string, askedKeys: string[], keptKeys: string[] = []) => {
    const result = readRepositoryAnswer(answer, {
      catalogKeys: CATALOG,
      askedKeys,
      askedQuestions: [],
      keptKeys,
    });
    expect(workScopeQuestionAnswerSchema.parse(result)).toEqual(result);
    return result;
  };

  it.each([
    ["github:acme/infra, but please do not touch github:acme/billing", ["github:acme/infra"]],
    ["please do not touch github:acme/billing", ["github:acme/infra"]],
    ["please do not use github:acme/billing", ["github:acme/infra"]],
    ["not github:acme/billing, web is fine", ["github:acme/web", "github:acme/docs"]],
    ["github:acme/infra, instead of github:acme/billing", ["github:acme/infra"]],
    ["no, github:acme/billing is enough", ["github:acme/infra"]],
    ["not github:acme/infra, go with github:acme/billing and github:acme/web", ["github:acme/infra"]],
    // The asked repository named where no no is: the person may want it, so
    // the cue beside billing cannot be read as a choice instead of it.
    ["github:acme/infra, but use github:acme/billing instead", ["github:acme/infra"]],
  ])("reads %j as unrecognised", (answer, askedKeys) => {
    expect(readAsked(answer, askedKeys)).toEqual({ kind: "unrecognised" });
  });

  // Round 4, and these three changed meaning. They were the redirects the
  // reader did take: a no beside a cue ("use X instead", "go with X") was read
  // as choosing X. The cue is gone with the rest of the clause machinery,
  // because the same reader that resolves these resolves the ones above, and
  // the two are told apart by phrasing rather than by intent. Every one of them
  // now comes back to the person with the rule: name only the repositories to
  // use.
  it.each([
    "no, use github:acme/billing instead",
    "not github:acme/infra, go with github:acme/billing",
    "github:acme/billing instead",
    // The Polish redirect our own copy used to teach, unreadable for exactly
    // the same reason and answered with exactly the same sentence.
    "nie bierz github:acme/infra, zamiast tego github:acme/billing",
  ])("reads %j as unrecognised, because it says no and names a repository", (answer) => {
    expect(readAsked(answer, ["github:acme/infra"])).toEqual({ kind: "unrecognised" });
  });

  // Round 4, B2 and M3: the retraction that names nothing, and the hedge. Both
  // were read as a plain choice, because the second thought carried no path for
  // a clause reader to attach it to. The rule needs neither: the reply says no,
  // so it records nothing and the question comes back.
  it.each([
    "use github:acme/ops. actually no, skip it",
    "github:acme/ops, no wait",
    "I would not use github:acme/api, maybe github:acme/ops",
    "not github:acme/api, github:acme/ops?",
    "nie jestem pewien, chyba github:acme/ops",
  ])("reads %j as unrecognised, because a second thought is still a no", (answer) => {
    expect(readAsked(answer, ["github:acme/ops"])).toEqual({ kind: "unrecognised" });
  });

  // Round 4, M5. Our own way-back sentence is built around the word "not", so a
  // person quoting it and agreeing would be refused by their own agreement.
  // Quoted lines are our words, and what is read is what they wrote under them.
  it("reads the reply under a quoted refusal sentence as the repository they named", () => {
    const quoted =
      "> github:acme/billing was listed in a repository question already answered on this" +
      " work and is not selected on it, so the run started without it.";
    expect(readAsked(`${quoted}\nyes, use github:acme/billing`, ["github:acme/billing"])).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/billing"],
    });
  });

  // Round 4, m9. The question lists the choices, so "all" has one meaning and
  // costing a person a round for it is a round spent on nothing.
  it.each(["all", "both", "wszystkie", "All of them."])(
    "reads %j as every repository the question listed",
    (answer) => {
      expect(readAsked(answer, ["github:acme/infra", "github:acme/billing"])).toEqual({
        kind: "repositories",
        repositoryKeys: ["github:acme/infra", "github:acme/billing"],
      });
    },
  );

  it("reads `all of the frontend ones` as unrecognised", () => {
    expect(readAsked("all of the frontend ones", ["github:acme/infra"])).toEqual({
      kind: "unrecognised",
    });
  });

  // S7: the question said these stay whatever the reply, so a reply naming them
  // records nothing about them and does not turn a path in the ticket into a
  // person's own selection.
  it("records nothing about a kept repository a reply names, and reads the rest", () => {
    const kept = ["github:acme/web", "github:acme/api"];
    expect(readAsked("github:acme/web and github:acme/infra", ["github:acme/infra"], kept)).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/infra"],
    });
    expect(readAsked("web, infra", ["github:acme/infra"], kept)).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/infra"],
    });
    expect(
      readAsked("keep github:acme/web and github:acme/api", ["github:acme/infra"], kept),
    ).toEqual({ kind: "unrecognised" });
    // Even with the words that make a redirect: the question said web stays,
    // so a no here is never a choice of web.
    expect(
      readAsked("not github:acme/infra, use github:acme/web instead", ["github:acme/infra"], kept),
    ).toEqual({ kind: "unrecognised" });
  });
});

// Round 5, A1 and A3: two replies that were read as more, or told less, than
// they said.
describe("readRepositoryAnswer counts the word against the list", () => {
  const CATALOG = ["infra", "web", "api", "docs"].map((name) => `github:acme/${name}`);
  const readAsked = (answer: string, askedKeys: string[]) =>
    readRepositoryAnswer(answer, { catalogKeys: CATALOG, askedKeys, askedQuestions: [] });

  // A1. "both" against four repositories is not agreement to four: the word and
  // the list contradict each other, and a contradiction recorded as a choice is
  // four permanent entries in that person's name.
  it.each(["both", "oba", "obie", "all three"])(
    "reads %j as unrecognised when the question listed four repositories",
    (answer) => {
      expect(readAsked(answer, CATALOG)).toEqual({ kind: "unrecognised" });
    },
  );

  it("reads `both` as the two repositories a question listing two asked about", () => {
    expect(readAsked("both", ["github:acme/infra", "github:acme/web"])).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/infra", "github:acme/web"],
    });
  });

  it("reads `all` as every repository however many the question listed", () => {
    expect(readAsked("all", CATALOG)).toEqual({ kind: "repositories", repositoryKeys: CATALOG });
  });

  // Round 6, R5. The words were missing from the map, so the least ambiguous
  // reply there is came back unreadable and the question was asked again for
  // nothing. "obydwa" and "obydwie" are how "both" is written here at least as
  // often as "oba", and a question listing three is answered "wszystkie trzy".
  it.each(["obydwa", "obydwie", "Obydwa."])(
    "reads %j as the two repositories a question listing two asked about",
    (answer) => {
      expect(readAsked(answer, ["github:acme/infra", "github:acme/web"])).toEqual({
        kind: "repositories",
        repositoryKeys: ["github:acme/infra", "github:acme/web"],
      });
    },
  );

  it("reads `wszystkie trzy` as the three repositories a question listing three asked about", () => {
    const three = ["github:acme/infra", "github:acme/web", "github:acme/api"];
    expect(readAsked("wszystkie trzy", three)).toEqual({
      kind: "repositories",
      repositoryKeys: three,
    });
  });

  // And they count like the words beside them: a number that disagrees with the
  // list decides nothing.
  it.each(["obydwa", "obydwie", "wszystkie trzy"])(
    "reads %j as unrecognised when the question listed four repositories",
    (answer) => {
      expect(readAsked(answer, CATALOG)).toEqual({ kind: "unrecognised" });
    },
  );
});

// A3. The sentence a person gets back has to be true of what they wrote. A no
// beside a BARE name is the commonest way anybody writes one, and telling them
// nothing in their answer named a repository is both false and the one reply
// that never teaches them the rule.
describe("answerSaysNoAndNamesARepository", () => {
  const CATALOG = ["github:acme/ops", "github:acme/api"];
  const says = (answer: string) =>
    answerSaysNoAndNamesARepository(answer, { catalogKeys: CATALOG, askedQuestions: [] });

  it.each([
    "nie, tylko ops",
    "no, just ops",
    "not api, ops",
    "no, github:acme/ops only",
  ])("is true for %j", (answer) => {
    expect(says(answer)).toBe(true);
  });

  it("is false for a reply that is nothing but a refusal", () => {
    expect(says("none")).toBe(false);
    expect(says("no")).toBe(false);
    expect(says("no\nnone of these")).toBe(false);
  });

  // The keyword rule reads "none, use github:acme/api" as a refusal whole,
  // because it opens with the word the question asks for. That person named a
  // repository, and the sentence they used to get back said nothing in their
  // answer named one, which is the nonsense this predicate exists to end.
  it("is true for a refusal keyword that names a repository after it", () => {
    expect(says("none, use github:acme/api")).toBe(true);
    expect(says("none, github:acme/api")).toBe(true);
  });

  it("is false for a reply that names a repository and says no about nothing", () => {
    expect(says("github:acme/ops")).toBe(false);
  });

  // M5. "none of the docs mention it" says no about nothing and names no
  // repository: the word quantifies a noun that happens to share a name with
  // one. Both halves of the sentence this predicate turns on would be false for
  // that person, and it would teach them a rule they had not broken.
  it("is false for prose whose negation quantifies a noun rather than refusing a repository", () => {
    const withDocs = (answer: string) =>
      answerSaysNoAndNamesARepository(answer, {
        catalogKeys: [...CATALOG, "github:acme/docs"],
        askedQuestions: [],
      });

    expect(withDocs("none of the docs mention it")).toBe(false);
    expect(withDocs("none of the docs cover this")).toBe(false);
    // And the refusals that really are about a repository still are: a phrase
    // that refuses on its own beside the name, and a negation governing it.
    expect(withDocs("no, just docs")).toBe(true);
    expect(withDocs("not docs, ops")).toBe(true);
    expect(withDocs("nie ruszajcie docs")).toBe(true);
  });
});
