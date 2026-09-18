import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCRUB_PLACEHOLDER } from "../publication/publication-scrub.js";
import {
  ANSWER_NOT_RECORDED_REASONS,
  CLARIFICATION_NUDGE_MARKER,
  formatAlreadyAnsweredComment,
  formatAnswerAlsoNamedComment,
  formatAnswerDelegatedComment,
  formatAnswerNotRecordedComment,
  formatAnswerUnreadableComment,
  formatClarificationNudgeComment,
  formatClarificationQuestionsComment,
  formatClarificationResumeFailedComment,
  formatClarificationUnreadableNudgeComment,
  aLaterRunCanPickUpAskedRepositories,
} from "./comment-format.js";

const DASHBOARD = "https://app/ticket/AWT-42?run=wrun_9";

describe("formatClarificationQuestionsComment", () => {
  it("numbers questions in order and includes dashboard URL and column name", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?", "Which branch?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toContain("1. Which repository?");
    expect(body).toContain("2. Which branch?");
    expect(body.indexOf("1. Which repository?")).toBeLessThan(
      body.indexOf("2. Which branch?"),
    );
    expect(body).toContain(`- In the dashboard: ${DASHBOARD}`);
    expect(body).toContain('move it back to the "AI" column.');
  });

  it("omits the suggested-answers block when null or empty", () => {
    const nullSuggestions = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(nullSuggestions).not.toContain("Suggested answers:");

    const emptySuggestions = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: [],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(emptySuggestions).not.toContain("Suggested answers:");
  });

  it("renders the suggested-answers block when present", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: ["the api repo", "the web repo"],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toContain("Suggested answers:");
    expect(body).toContain("- the api repo");
    expect(body).toContain("- the web repo");
  });

  it("renders the expiry paragraph from the ISO input as a UTC minute", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: "2026-07-29T14:03:07.512Z",
    });
    expect(body).toContain(
      "The paused run is resumable until 2026-07-29 14:03 UTC.",
    );
    expect(body).toContain("the ticket starts over from scratch.");
  });

  // The ticket comment is the only channel the sentence about taking an
  // exclusion back travels on: it must never ride the questions, which become
  // the agent's prompts and its "Human decisions" memory. The ruling is at the
  // call site in `engine/agent-workflow.ts`.
  it("puts what a person can do about a left-out repository under the questions", () => {
    const body = formatClarificationQuestionsComment({
      questions: [
        "github:acme/api was excluded on this work, so the run started without it." +
          " Which repository should this ticket modify?",
      ],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
      repositoryRecoveryNotes: [
        "Excluding a repository is not final: this work's repository list can be changed" +
          " through the work scope API or the work_scope.edit tool," +
          " and the next run starts from the changed list.",
      ],
    });

    expect(body).toContain(
      "Excluding a repository is not final: this work's repository list can be changed" +
        " through the work scope API or the work_scope.edit tool,",
    );
    // Under the question it is about, and above the instructions, because it
    // widens what an answer could be rather than explaining how to send one.
    expect(body.indexOf("1. github:acme/api was excluded")).toBeLessThan(
      body.indexOf("Excluding a repository is not final"),
    );
    expect(body.indexOf("Excluding a repository is not final")).toBeLessThan(
      body.indexOf("How to answer:"),
    );
  });

  it("is byte-identical to the comment it was when nothing was left out", () => {
    // Every clarification that is not about repositories reads exactly as
    // before: an orphaned sentence about exclusions answers a question the
    // reader was never asked.
    // Typed off the function rather than frozen with `as const`: the parameter
    // asks for a mutable `string[]`, and a readonly literal is not one.
    const base: Parameters<typeof formatClarificationQuestionsComment>[0] = {
      questions: ["Which repository?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    };

    expect(formatClarificationQuestionsComment({ ...base, repositoryRecoveryNotes: [] })).toBe(
      formatClarificationQuestionsComment(base),
    );
    expect(formatClarificationQuestionsComment(base)).not.toContain("not final");
  });

  it("omits the expiry paragraph when expiresAtIso is null", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository?"],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).not.toContain("resumable until");
  });
});

describe("formatClarificationQuestionsComment publication scrub", () => {
  it("leaves a comment with nothing to scrub byte-identical", () => {
    const body = formatClarificationQuestionsComment({
      questions: [
        "Should the retry live in apps/api/src/queue/retry.ts?",
        "Which module owns the fixture src/fixtures/memory/AWP-28.md, apps/web or packages/core?",
      ],
      suggestedAnswers: ["apps/web is the source of truth", "Keep both, behind a flag"],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: "2026-07-29T14:03:07.512Z",
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Should the retry live in apps/api/src/queue/retry.ts?",
        "2. Which module owns the fixture src/fixtures/memory/AWP-28.md, apps/web or packages/core?",
        "",
        "Suggested answers:",
        "- apps/web is the source of truth",
        "- Keep both, behind a flag",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
        "",
        "The paused run is resumable until 2026-07-29 14:03 UTC. After that the ticket starts over from scratch.",
      ].join("\n"),
    );
  });

  it("removes the platform bookkeeping sentence from a question and keeps the question", () => {
    const body = formatClarificationQuestionsComment({
      questions: [
        "Session memory was overwritten in blazebot/memory/AWP-28.md. Which repository should the fix land in?",
        "Should the retry budget stay at three attempts?",
      ],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Which repository should the fix land in?",
        "2. Should the retry budget stay at three attempts?",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
      ].join("\n"),
    );
  });

  it("keeps the numbering when a question is entirely platform bookkeeping", () => {
    const body = formatClarificationQuestionsComment({
      questions: [
        "I did not push or open a PR because this sandbox workflow explicitly forbids publish actions.",
        "Should the retry budget stay at three attempts?",
      ],
      suggestedAnswers: null,
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        `1. ${SCRUB_PLACEHOLDER}`,
        "2. Should the retry budget stay at three attempts?",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
      ].join("\n"),
    );
  });

  it("scrubs the suggested answers too", () => {
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository should the fix land in?"],
      suggestedAnswers: [
        "The api repo, as recorded in blazebot/memory/AWP-28.md",
        "The web repo",
      ],
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Which repository should the fix land in?",
        "",
        "Suggested answers:",
        `- ${SCRUB_PLACEHOLDER}`,
        "- The web repo",
        "",
        "How to answer:",
        `- In the dashboard: ${DASHBOARD}`,
        '- Or reply in a comment on this ticket and move it back to the "AI" column.',
      ].join("\n"),
    );
  });

  it("leaves the platform-generated fields alone even when they carry marker-shaped text", () => {
    // Neither value can look like this in production: the URL is built from
    // DASHBOARD_ORIGIN and the column name comes from COLUMN_AI. They carry
    // markers here to pin which strings the scrub is allowed to touch, so a
    // scrub applied to the composed comment or to the wrong field is visible.
    const url = "https://app/ticket/AWT-42?run=wrun_9&from=blazebot/memory/AWP-28.md";
    const body = formatClarificationQuestionsComment({
      questions: ["Which repository should the fix land in?"],
      suggestedAnswers: null,
      dashboardUrl: url,
      aiColumnName: "Session memory",
      expiresAtIso: null,
    });
    expect(body).toBe(
      [
        "The AI workflow needs clarification before it can continue with this ticket:",
        "",
        "1. Which repository should the fix land in?",
        "",
        "How to answer:",
        `- In the dashboard: ${url}`,
        '- Or reply in a comment on this ticket and move it back to the "Session memory" column.',
      ].join("\n"),
    );
  });
});

describe("formatClarificationNudgeComment", () => {
  it("contains the marker and the dashboard URL and column name", () => {
    const body = formatClarificationNudgeComment({
      dashboardUrl: DASHBOARD,
      aiColumnName: "AI",
    });
    expect(body).toContain(CLARIFICATION_NUDGE_MARKER);
    expect(body).toContain(DASHBOARD);
    expect(body).toContain('move the ticket back to the "AI" column.');
  });
});

describe("formatAlreadyAnsweredComment", () => {
  it("names the label who answered", () => {
    expect(formatAlreadyAnsweredComment({ answeredByLabel: "Jane Doe" })).toContain(
      "Jane Doe",
    );
  });
});

/**
 * Rule 6: a remedy we offer has to work when the person does it.
 *
 * The rule is a property of every sentence we write, not a habit kept up one
 * sentence at a time, so this walks every comment we post AFTER a clarification
 * is answered and holds each of them to it. By then the comment channel reads
 * nothing: `answerHookClarification` writes only while the row is `pending`
 * (`db/repositories/clarification-hooks.ts`), so a person told to reply under a
 * closed question writes the word and watches nothing happen.
 *
 * The reasons come from the reason map itself, so a seventh reason is covered on
 * the day it is added rather than on the day somebody remembers this test.
 *
 * WHAT IS NOT HERE, AND WHY IT IS NOT ONE TEST WITH THIS. The nudge is posted
 * while the question is OPEN, where replying is exactly what works, so the same
 * rule reaches the opposite sentence there; the second test below pins that
 * direction. The exclusion recovery sentence names a route rather than an act,
 * so its risk is that the route stops existing, not that it closes: that is
 * guarded where the route is walked
 * (`services/work-scope/exclusion-reversal.test.ts`). And the answer echo
 * comment is a transcript of a person's own words, which are theirs and not
 * ours to hold to a rule about our sentences.
 */
describe("rule 6: every sentence we write after the question is answered", () => {
  /** An instruction to the person, as opposed to a report about what happened.
   *  The lookbehind is the whole difference: "Your answer reached the run" is a
   *  noun and a report, `answer "none" the next time` is a verb and an act. */
  const INSTRUCTION =
    /(?<!\b(?:the|that|this|a|an|your|their|its|one|no|every|each|same|first)\s)\b(?:reply|respond|answer|write|post|send|start|check)\b/i;
  /** The readers an instruction may name, every one of them later than this
   *  closed question. A sentence telling somebody to do something that this
   *  question would have to read names none of them, because nothing is left
   *  reading it. */
  const LATER_READER =
    /(?:the next run|the next time the question is asked|a later run|a new run)/i;

  function sentencesOf(comment: string): string[] {
    return comment
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);
  }

  function closedQuestionComments(): Array<{ where: string; body: string }> {
    const comments: Array<{ where: string; body: string }> = [];
    for (const reason of ANSWER_NOT_RECORDED_REASONS) {
      // Every shape of question, because what a person was shown decides which
      // words are offered back to them, and whether a written path could reach
      // any of it decides whether those words are true.
      for (const listedCount of [0, 1, 4]) {
        for (const aLaterRunCanPickThemUp of [true, false]) {
          for (const commentPath of ["too_many_open", "unproven"] as const) {
            comments.push({
              where:
                `answer not recorded, ${reason}, question listed repositories:` +
                ` ${listedCount}, pickable: ${aLaterRunCanPickThemUp},` +
                ` comment path: ${commentPath}`,
              body: formatAnswerNotRecordedComment(reason, {
                listedCount,
                aLaterRunCanPickThemUp,
                commentPath,
              }),
            });
          }
        }
      }
    }
    comments.push(
      {
        where: "resume failed",
        body: formatClarificationResumeFailedComment({ attempts: 3, error: "transport failed" }),
      },
      {
        where: "already answered",
        body: formatAlreadyAnsweredComment({ answeredByLabel: "Ada Lovelace" }),
      },
    );
    return comments;
  }

  it("never sends a person back into a question that is already answered, whatever left the record empty", () => {
    // A vacuous walk would pass this test in silence.
    expect(ANSWER_NOT_RECORDED_REASONS).toContain("no_words");
    expect(ANSWER_NOT_RECORDED_REASONS.length).toBeGreaterThan(5);

    for (const { where, body } of closedQuestionComments()) {
      for (const sentence of sentencesOf(body)) {
        if (!INSTRUCTION.test(sentence)) continue;
        expect(`${where} :: ${sentence}`).toMatch(LATER_READER);
      }
    }
  });

  it("tells a person what does work, rather than paying for the closed route with silence", () => {
    for (const reason of ANSWER_NOT_RECORDED_REASONS) {
      for (const listedCount of [0, 1, 4]) {
        for (const aLaterRunCanPickThemUp of [true, false]) {
          for (const commentPath of ["too_many_open", "unproven"] as const) {
            const body = formatAnswerNotRecordedComment(reason, {
              listedCount,
              aLaterRunCanPickThemUp,
              commentPath,
            });
            expect(`${reason} :: ${body}`).toMatch(LATER_READER);
          }
        }
      }
    }
  });

  it("sends a person to a screen that exists, where a repository can be added or enabled", () => {
    // The other remedies name a later reader, which this file can hold them to
    // on its own. This one names a place, so holding it to the same rule means
    // going and looking: a sentence telling somebody a screen can fix this is
    // worth nothing if the screen is not there.
    const screen = (file: string) =>
      fileURLToPath(new URL(`../../../../dashboard/app/(cockpit)/repositories/${file}`, import.meta.url));
    const comment = formatAnswerNotRecordedComment("no_such_repository", {
      listedCount: 0,
      aLaterRunCanPickThemUp: false,
      commentPath: "unproven",
    });

    expect(comment).toContain("the repositories screen can add or enable it");
    expect(existsSync(screen("page.tsx"))).toBe(true);
    // The two acts the sentence promises, on that screen: one dialog that adds
    // a repository the deployment does not hold, and an entry that carries
    // whether it is enabled.
    expect(existsSync(screen("import-dialog.tsx"))).toBe(true);
    expect(readFileSync(screen("repositories-screen.tsx"), "utf8")).toContain("enabled");
  });

  // Joint gate F4. A question raised mid run proves nothing about how many
  // repositories the ticket names, so the comment route is not offered at all:
  // only the two routes that work whatever the ticket says.
  it("offers only routes that work when nothing here can prove the comment is taken", () => {
    for (const reason of ANSWER_NOT_RECORDED_REASONS) {
      if (reason === "no_such_repository") continue;
      const body = formatAnswerNotRecordedComment(reason, {
        listedCount: 4,
        aLaterRunCanPickThemUp: true,
        commentPath: "unproven",
      });

      expect(`${reason} :: ${body}`).not.toContain("in a comment here");
      expect(`${reason} :: ${body}`).toContain(
        "To use one of them after all, select it in this work's repository list through the work" +
          " scope API or the work_scope.edit tool, which the next run starts from, or name it the" +
          " next time the question is asked.",
      );
    }
  });

  // AWP-254 on production: the question was about ONE repository the catalog
  // does not enable, and the note said "Writing one of their paths in a comment
  // here reaches nothing, because the catalog cannot serve them".
  it("speaks of the one repository a question asked about in the singular", () => {
    const blocked = formatAnswerNotRecordedComment("unaddressed_refusal", {
      listedCount: 1,
      aLaterRunCanPickThemUp: false,
      commentPath: "unproven",
    });

    expect(blocked).toContain(
      "Writing its path in a comment here reaches nothing, because the catalog cannot serve it as" +
        " things stand: somebody with access to the repositories screen has to enable it there" +
        " before any run can use it, and naming it the next time the question is asked records it then.",
    );
    expect(blocked).not.toMatch(/\b(their|them)\b/);

    const pickable = formatAnswerNotRecordedComment("no_repository_named", {
      listedCount: 1,
      aLaterRunCanPickThemUp: true,
      commentPath: "unproven",
    });

    expect(pickable).toContain(
      "To use it after all, select it in this work's repository list through the work scope API" +
        " or the work_scope.edit tool, which the next run starts from, or name it the next time" +
        " the question is asked.",
    );
  });

  it("tells a wordless answer what the run did AND what the record kept, which is nothing", () => {
    // A thumbs up on the dashboard is stored raw, and the run's own reader takes
    // the wordless branch: it stops asking and carries on WITHOUT those
    // repositories. The record does the opposite of deciding, because a
    // permanent refusal is not a thing to read out of an emoji
    // (`saysNothingToAttach`). Told only the first half, the person reads a
    // decision they never made; told only the second, they think the run waited
    // for them.
    const body = formatAnswerNotRecordedComment("no_words", {
      listedCount: 4,
      aLaterRunCanPickThemUp: true,
      commentPath: "unproven",
    });

    expect(body).toContain(
      "continuing without the repositories the question asked about." +
        " Nothing was recorded about them, so a later run may use them and may ask about them again.",
    );
    // And never the sentence that belongs to an answer the record DID keep: an
    // omission binds later runs only when the answer was read as one.
    expect(body).not.toContain("is not selected on it");
  });

  it("uses singular wording for a wordless answer when the question named exactly one repository", () => {
    // The same fact as above, said about one repository: "the repositories"
    // and "them" about a single name reads as if more than one had been
    // asked about.
    const body = formatAnswerNotRecordedComment("no_words", {
      listedCount: 1,
      aLaterRunCanPickThemUp: true,
      commentPath: "unproven",
    });

    expect(body).toContain(
      "continuing without the repository the question asked about." +
        " Nothing was recorded about it, so a later run may use it and may ask about it again.",
    );
  });

  it("does not send a person to write a path for a repository no run could read back", () => {
    // The run itself put these in front of the person: a question may list a
    // repository the catalog does not enable or cannot serve. The next run
    // matches written paths against the repositories it froze at its start, so
    // the path route named in the ordinary sentence would swallow their second
    // attempt and say nothing. What is true instead is the catalog.
    const blocked = formatAnswerNotRecordedComment("no_repository_named", {
      listedCount: 4,
      aLaterRunCanPickThemUp: false,
      commentPath: "unproven",
    });

    expect(blocked).toContain("reaches nothing");
    expect(blocked).toContain("the repositories screen");
    expect(blocked).not.toContain("write its full path in a comment here");

    // The control, and the whole reason the fact is carried rather than
    // assumed: the ordinary question, whose repositories a later run CAN pick
    // up, still gets the sentence that is true for it, which since joint gate
    // round 3 (R8) names the routes that work whatever the ticket says.
    const ordinary = formatAnswerNotRecordedComment("no_repository_named", {
      listedCount: 4,
      aLaterRunCanPickThemUp: true,
      commentPath: "unproven",
    });

    expect(ordinary).toContain("select it in this work's repository list");
    expect(ordinary).not.toContain("reaches nothing");
  });

  it("does not send a person to write a path while the question listed more than three repositories", () => {
    // The which-of-these question about a ticket that names more than three.
    // The next run reads the path in the comment and takes nothing from the
    // text, because that many is a choice it asks about, so the ordinary
    // sentence would swallow the second attempt and ask the same question. The
    // two routes that settle it are the question itself when it comes back and
    // the work's repository list.
    //
    // Round 5, S2, and the pinned text changed meaning here. It used to end
    // "because the next run then asks which of them to start from instead",
    // which is a question this surface cannot promise: once something on this
    // work has answered it, the ticket's text is read by nobody and no question
    // comes back. The sentence now states the outcome the person can count on
    // and leaves the question open.
    for (const reason of ANSWER_NOT_RECORDED_REASONS) {
      if (reason === "no_such_repository") continue;
      const tooMany = formatAnswerNotRecordedComment(reason, {
        listedCount: 4,
        aLaterRunCanPickThemUp: true,
        commentPath: "too_many_open",
      });

      expect(`${reason} :: ${tooMany}`).not.toContain("write its full path in a comment here");
      expect(`${reason} :: ${tooMany}`).toContain(
        "Writing one of their paths in a comment here brings nothing into this work while this" +
          " ticket names more than three repositories a run could still start from, and the next run" +
          " may not ask about them either. To use one of them, name it the next time the question is" +
          " asked, or select it in this work's repository list through the work scope API or the" +
          " work_scope.edit tool, which the next run starts from.",
      );
    }
  });

  it("reads the closed path route off the reason each repository was asked about", () => {
    // The two reasons a question raises about a repository this deployment
    // cannot open (`engine/work-scope/decide.ts`). Neither is in the list the
    // next run matches paths against: `not_enabled` because that list IS the
    // enabled list, `unusable` because the matcher scans the usable subset of
    // it.
    expect(aLaterRunCanPickUpAskedRepositories([{ askedBecause: "not_enabled" }])).toBe(false);
    expect(aLaterRunCanPickUpAskedRepositories([{ askedBecause: "unusable" }])).toBe(false);
    // The other two name a repository the deployment holds and can serve, so a
    // path written in a comment is read and the sentence stays as it was.
    expect(aLaterRunCanPickUpAskedRepositories([{ askedBecause: "selection" }])).toBe(true);
    expect(aLaterRunCanPickUpAskedRepositories([{ askedBecause: "outside_policy" }])).toBe(true);
    // ANY, not every: one repository a written path can reach keeps the
    // ordinary sentence true of the question as a whole, and the alternative
    // would be the same false sentence with its sign flipped.
    expect(
      aLaterRunCanPickUpAskedRepositories([
        { askedBecause: "not_enabled" },
        { askedBecause: "selection" },
      ]),
    ).toBe(true);
  });

  it("does tell a person to reply while the question is still open, which is the same rule reaching the other answer", () => {
    // Not a contradiction of the test above, and the reason the two cannot be
    // one test: a nudge is posted while the clarification is `pending`, the one
    // state the comment path writes into. Replying works there, so saying so is
    // the honest sentence and the guard is that it keeps saying so.
    for (const body of [
      formatClarificationNudgeComment({ dashboardUrl: DASHBOARD, aiColumnName: "AI" }),
      formatClarificationUnreadableNudgeComment({ dashboardUrl: DASHBOARD, aiColumnName: "AI" }),
    ]) {
      expect(body).toContain("reply in a comment here");
      expect(body).toContain(DASHBOARD);
    }
  });
});

describe("formatAnswerUnreadableComment", () => {
  const ONE_REPOSITORY = { shape: "one" as const, askedKeys: ["github:acme/api"] };
  const THE_ASK = 'Reply "yes" to use github:acme/api in this work, or "no" to continue without it.';

  // The wording is the owner's, written out here rather than rebuilt from the
  // formatter: a person whose unclear reply sent the ticket back learns where it
  // waits and the one gesture that hands it to the run again.
  it("says where the ticket waits and how to hand it back, after the ask, when the ticket was moved", () => {
    const body = formatAnswerUnreadableComment({
      ...ONE_REPOSITORY,
      waiting: { backlogColumnName: "Backlog", aiColumnName: "AI" },
    });

    const paragraphs = body.split("\n\n");
    expect(paragraphs.at(-2)).toBe(THE_ASK);
    expect(paragraphs.at(-1)).toBe(
      'This ticket is back in the "Backlog" column while the question waits. Reply in a comment here and move it to the "AI" column again, or answer in the dashboard.',
    );
  });

  it("says nothing about a column when the ticket was not moved", () => {
    const body = formatAnswerUnreadableComment(ONE_REPOSITORY);

    expect(body.split("\n\n").at(-1)).toBe(THE_ASK);
    expect(body).not.toContain("column");
  });
});

/**
 * WHAT A PERSON WHO HANDED THE DECISION BACK IS TOLD.
 *
 * Three things, and each is a defect when missing: what the workflow took, what
 * it left and that nothing binds those, and a way to change it that works on
 * the channel they answered in.
 */
describe("formatAnswerDelegatedComment", () => {
  const API = "github:acme/api";
  const WEB = "github:acme/web";
  const DOCS = "github:acme/docs";
  const OPS = "github:acme/ops";

  // AWP-247 on production, word for word what the person reads now. The old
  // note said a later run "may still take it or ask about it" and then that
  // "the next run may not ask about them either", called one repository
  // "their paths", and told them about enabling although everything it took
  // was enabled. And the same run's agent took the one it left open three
  // minutes later, so "a later run" was not the whole truth either.
  it("reads as one message: what it took, what it left open and who may still take it, and one way to change it", () => {
    const body = formatAnswerDelegatedComment({
      taken: [API, WEB, DOCS],
      notTaken: [OPS],
      notEnabled: [],
      commentPath: "too_many_open",
    });

    expect(body).toBe(
      `You asked the workflow to decide, so it chose ${API}, ${WEB}, ${DOCS} for this work, in the order the question listed them.` +
        ` It left ${OPS} open: nothing is recorded about it, so this run's agent or a later run may still take it if the work needs it.` +
        " Writing its path in a comment here does not bring it in while this ticket names more than three repositories a run could still start from." +
        " To change what this work uses, select or remove repositories in this work's repository list, through the work scope API or the work_scope.edit tool.",
    );
  });

  it("speaks of several repositories left open in the plural", () => {
    const body = formatAnswerDelegatedComment({
      taken: [API, WEB, DOCS],
      notTaken: [OPS, "github:acme/jobs"],
      notEnabled: [],
      commentPath: "too_many_open",
    });

    expect(body).toContain(
      `It left ${OPS}, github:acme/jobs open: nothing is recorded about them, so this run's agent or a later run may still take them if the work needs them.`,
    );
    expect(body).toContain("Writing their paths in a comment here does not bring them in");
  });

  // AWP-256 on production: the question was about a repository this deployment
  // does not enable, so that is the one place the enabling sentence is true, and
  // it is the sentence the run itself uses for that repository.
  it("says a repository is not enabled only when one it names is not", () => {
    const body = formatAnswerDelegatedComment({
      taken: [],
      notTaken: [API],
      notEnabled: [API],
      commentPath: "unproven",
    });

    expect(body).toBe(
      `You asked the workflow to decide, and it continues without ${API}, because this run cannot use it as things stand.` +
        " Nothing is recorded about it, so a later run may ask about it again." +
        ` ${API} is not enabled on the Repositories page. Somebody with access to that page can enable it, and until then no run can use it.` +
        " To change what this work uses, select or remove repositories in this work's repository list, through the work scope API or the work_scope.edit tool.",
    );
  });

  // A left-open repository this deployment does not enable cannot be taken by
  // any run, this one's agent included, until somebody enables it: the "may
  // still take it" claim would be false for it, so it is left out of that
  // claim and gets only the separate enabling sentence.
  it("does not claim a later run may still take a left-open repository this deployment does not enable", () => {
    const body = formatAnswerDelegatedComment({
      taken: [API],
      notTaken: [OPS],
      notEnabled: [OPS],
      commentPath: "unproven",
    });

    expect(body).not.toContain("may still take");
    expect(body).toContain(
      `${OPS} is not enabled on the Repositories page. Somebody with access to that page can enable it, and until then no run can use it.`,
    );
  });

  it("splits a mixed left-open list: the usable repositories may still be taken, the rest wait on enabling", () => {
    const body = formatAnswerDelegatedComment({
      taken: [API],
      notTaken: [WEB, DOCS, OPS],
      notEnabled: [OPS],
      commentPath: "unproven",
    });

    expect(body).toContain(
      `It left ${WEB}, ${DOCS} open: nothing is recorded about them, so this run's agent or a later run may still take them if the work needs them.`,
    );
    // OPS is left open too, but never as something this run's agent or a
    // later run may take.
    expect(body).not.toContain(`${OPS} open`);
    expect(body).toContain(
      `${OPS} is not enabled on the Repositories page. Somebody with access to that page can enable it, and until then no run can use it.`,
    );
  });

  it("names what was taken, in the question's order, and what was left open", () => {
    const body = formatAnswerDelegatedComment({
      taken: [API, WEB, DOCS],
      notTaken: [OPS],
      notEnabled: [],
      commentPath: "unproven",
    });

    expect(body).toContain(`${API}, ${WEB}, ${DOCS}`);
    expect(body).toContain(OPS);
    // A delegation binds only what it took, and the sentence may not claim more.
    expect(body).toContain("nothing is recorded about it");
    expect(body).not.toContain("left out of this work");
  });

  it("says the workflow chose, never that the person did", () => {
    const body = formatAnswerDelegatedComment({ taken: [API], notTaken: [], notEnabled: [], commentPath: "unproven" });

    expect(body).toMatch(/asked the workflow to decide/);
    expect(body).not.toMatch(/you (chose|named|selected)/i);
  });

  it("says the run continues without a repository it could not take", () => {
    const body = formatAnswerDelegatedComment({ taken: [], notTaken: [API], notEnabled: [], commentPath: "unproven" });

    expect(body).toContain(`continues without ${API}`);
    expect(body).not.toMatch(/chose github/);
  });

  // Every repository the question listed already carries a person's own
  // decision, so the workflow had nothing left to choose among. Both lists are
  // empty, and a sentence built for one of them reads "continues without ,".
  it("says it changed nothing when a person had already decided on everything the question listed", () => {
    const body = formatAnswerDelegatedComment({ taken: [], notTaken: [], notEnabled: [], commentPath: "unproven" });

    expect(body).toContain("already carries a decision a person made on this work");
    expect(body).not.toMatch(/without\s*[,.]/);
  });

  // With more than three open the comment route is shut, so a person answering
  // on the ticket must not be sent to write a path there.
  it("tells a ticket reader that a path in a comment brings nothing in while too many are open", () => {
    const shut = formatAnswerDelegatedComment({
      taken: [API, WEB, DOCS],
      notTaken: [OPS],
      notEnabled: [],
      commentPath: "too_many_open",
    });
    const open = formatAnswerDelegatedComment({
      taken: [API, WEB, DOCS],
      notTaken: [OPS],
      notEnabled: [],
      commentPath: "unproven",
    });

    expect(shut).toContain("does not bring it in while this ticket names more than three repositories");
    expect(open).not.toContain("in a comment");
    for (const body of [shut, open]) {
      expect(body).toContain("work scope API or the work_scope.edit tool");
    }
  });
});

/**
 * WHAT A PERSON WHO NAMED A REPOSITORY THE QUESTION NEVER LISTED IS TOLD.
 */
describe("formatAnswerAlsoNamedComment", () => {
  it("says a name the catalog holds and enables is now part of this work as their choice", () => {
    const body = formatAnswerAlsoNamedComment({
      added: ["github:acme/billing"],
      notEnabled: [],
      unmatched: [],
    });

    expect(body).toContain("github:acme/billing");
    expect(body).toContain("as your choice");
  });

  it("names the repository this deployment does not enable, and the page that enables it", () => {
    const body = formatAnswerAlsoNamedComment({
      added: [],
      notEnabled: ["github:acme/legacy"],
      unmatched: [],
    });

    expect(body).toContain("github:acme/legacy is not enabled on the Repositories page");
    expect(body).toContain("until then no run can use it");
  });

  it("says a name that matched nothing recorded nothing", () => {
    const body = formatAnswerAlsoNamedComment({
      added: [],
      notEnabled: [],
      unmatched: ["github:evil/other"],
    });

    expect(body).toContain("github:evil/other");
    expect(body).toContain("nothing about it was recorded");
  });

  // AWP-252 on production: the name matched nothing, and the note sent them to
  // select it through work_scope.edit, which refuses a key the catalog does not
  // hold. What can work is the spelling, or the catalog.
  it("tells a person whose name matched nothing to check it or have it added, never to select it", () => {
    const body = formatAnswerAlsoNamedComment({
      added: [],
      notEnabled: [],
      unmatched: ["github:acme/does-not-exist"],
    });

    expect(body).toBe(
      "Your answer also named github:acme/does-not-exist, which could not be matched to a repository" +
        " this deployment holds, so nothing about it was recorded. A repository is matched by its full" +
        " path, such as github:acme/app: check how it was written, and if it is right, it has to be" +
        " added to this deployment's catalog on the repositories screen before this work can use it.",
    );
  });

  it("says the same of several names in the plural", () => {
    const body = formatAnswerAlsoNamedComment({
      added: [],
      notEnabled: [],
      unmatched: ["github:acme/one", "github:acme/two"],
    });

    expect(body).toContain(
      "so nothing about them was recorded. A repository is matched by its full path, such as" +
        " github:acme/app: check how they were written, and if a name is right, that repository has to be added",
    );
  });

  it("keeps the repository list as the route for a name held here but past what one answer records", () => {
    const body = formatAnswerAlsoNamedComment({
      added: [],
      notEnabled: [],
      unmatched: [],
      overLimit: ["github:acme/jobs"],
    });

    expect(body).toContain("To add it to this work, select it in this work's repository list");
    expect(body).not.toContain("check how");
  });
});
