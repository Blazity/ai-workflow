import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCRUB_PLACEHOLDER } from "../publication/publication-scrub.js";
import {
  ANSWER_NOT_RECORDED_REASONS,
  CLARIFICATION_NUDGE_MARKER,
  formatAlreadyAnsweredComment,
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
      for (const listedRepositories of [true, false]) {
        for (const aLaterRunCanPickThemUp of [true, false]) {
          for (const commentPath of ["too_many_open", "unproven"] as const) {
            comments.push({
              where:
                `answer not recorded, ${reason}, question listed repositories:` +
                ` ${listedRepositories}, pickable: ${aLaterRunCanPickThemUp},` +
                ` comment path: ${commentPath}`,
              body: formatAnswerNotRecordedComment(reason, {
                listedRepositories,
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
      for (const listedRepositories of [true, false]) {
        for (const aLaterRunCanPickThemUp of [true, false]) {
          for (const commentPath of ["too_many_open", "unproven"] as const) {
            const body = formatAnswerNotRecordedComment(reason, {
              listedRepositories,
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
      listedRepositories: false,
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
        listedRepositories: true,
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

  it("tells a wordless answer what the run did AND what the record kept, which is nothing", () => {
    // A thumbs up on the dashboard is stored raw, and the run's own reader takes
    // the wordless branch: it stops asking and carries on WITHOUT those
    // repositories. The record does the opposite of deciding, because a
    // permanent refusal is not a thing to read out of an emoji
    // (`saysNothingToAttach`). Told only the first half, the person reads a
    // decision they never made; told only the second, they think the run waited
    // for them.
    const body = formatAnswerNotRecordedComment("no_words", {
      listedRepositories: true,
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

  it("does not send a person to write a path for a repository no run could read back", () => {
    // The run itself put these in front of the person: a question may list a
    // repository the catalog does not enable or cannot serve. The next run
    // matches written paths against the repositories it froze at its start, so
    // the path route named in the ordinary sentence would swallow their second
    // attempt and say nothing. What is true instead is the catalog.
    const blocked = formatAnswerNotRecordedComment("no_repository_named", {
      listedRepositories: true,
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
      listedRepositories: true,
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
        listedRepositories: true,
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
