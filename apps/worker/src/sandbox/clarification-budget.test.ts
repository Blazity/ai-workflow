import { describe, expect, it } from "vitest";
import { joinPromptParts } from "@shared/prompts";

import { researchPlanContextParts } from "./context.js";
/** The shape the assemblers take, which `sandbox/context.ts` keeps private. A
 *  test fixture is built structurally and cast at the seam, exactly as the
 *  oracle's matrix does. */
type TicketLike = Parameters<typeof researchPlanContextParts>[0]["ticket"];

/**
 * WHAT THE PROMPT SAYS WAS CUT HAS TO BE WHAT WAS CUT.
 *
 * The clarification history is capped, and one sentence used to explain every
 * way of hitting that cap: "[Older clarification rounds omitted to fit the
 * prompt budget.]". It is true when older rounds were dropped. It is FALSE when
 * the newest round alone was over budget and was shortened in place, which is
 * the case that matters most, because then the question and the answer the
 * model is reading are both partial and it has just been told the opposite. On
 * a subject with one round it is false twice over: nothing older exists.
 *
 * After stage 2 this text is a named part, so the same bytes reach the model
 * and the briefing a person reads. A note that lies here lies in both places.
 */

const ROUND_HEADER_AND_FOOTER = "\n## Clarifications (Q&A)\n\n".length + "\n".length;
/** The cap the section is written against, spelled here so a test that stops
 *  crossing it fails rather than quietly asserting nothing. */
const CLARIFICATIONS_MAX_LENGTH = 16_000;

function round(index: number, size: number) {
  return {
    questions: [`Question ${index} ${"q".repeat(size)}`, `Second question ${index}`],
    answer: `Answer ${index} ${"a".repeat(size)}`,
    answeredBy: `person-${index}`,
    answeredAt: `2026-09-1${index}T10:00:00.000Z`,
  };
}

function ticketWith(clarifications: ReturnType<typeof round>[]): TicketLike {
  return {
    identifier: "AIW-512",
    title: "Session refresh drops the user after a deploy",
    description: "After every deploy, users with an open tab are logged out.",
    acceptanceCriteria: "A deploy does not log anybody out.",
    comments: [],
    clarifications,
  } as unknown as TicketLike;
}

function clarificationSection(clarifications: ReturnType<typeof round>[]) {
  const parts = researchPlanContextParts({
    ticket: ticketWith(clarifications),
    prompt: "",
    branchName: "ai-workflow/aiw-512",
    attachments: [],
    preSandboxAdditions: [],
    repositoryContexts: [],
    selectedRepositories: [],
  });
  const note = parts.find((part) => part.id === "clarifications-omitted");
  const rounds = parts.filter((part) => part.id.startsWith("clarification:"));
  const text = joinPromptParts(parts);
  const start = text.indexOf("\n## Clarifications (Q&A)\n");
  const section = start < 0 ? "" : text.slice(start, text.indexOf("\n## ", start + 5));
  return { note, rounds, section, text };
}

describe("the clarification budget says what it actually cut", () => {
  it("says nothing at all when nothing was cut", () => {
    const { note, rounds } = clarificationSection([round(1, 3), round(2, 3)]);
    expect(note).toBeUndefined();
    expect(rounds.map((part) => part.cutBeforeSend)).toEqual([undefined, undefined]);
  });

  it("counts the rounds it dropped, and says the ones that are left are whole", () => {
    // Six rounds of about 3 KB each: the oldest goes, the rest survive intact.
    const { note, rounds, section } = clarificationSection(
      [1, 2, 3, 4, 5, 6].map((index) => round(index, 1_500)),
    );
    const dropped = rounds.filter((part) => part.cutBeforeSend === "whole");
    expect(dropped.map((part) => part.id)).toEqual(["clarification:1"]);
    expect(note?.title).toBe("Older clarification rounds left out");
    expect(note?.content).toBe(
      "[Prompt budget: the oldest of this work's 6 clarification rounds is not here. Every round below is complete.]\n\n",
    );
    // The claim it makes about the rounds below is true of every one of them.
    expect(rounds.filter((part) => part.cutBeforeSend === "partial")).toEqual([]);
    expect(section.length).toBeLessThan(CLARIFICATIONS_MAX_LENGTH + 200);
  });

  it("says THIS round was shortened, and never that an older one is missing", () => {
    // The lie, exactly: one round, too long for the budget, cut in place. The
    // old note told the model that what it was holding was complete and that
    // something older had been dropped. Both halves were false.
    const { note, rounds } = clarificationSection([round(1, 9_000)]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.cutBeforeSend).toBe("partial");
    expect(note?.title).toBe("The clarification round was shortened");
    expect(note?.content).toContain("the round below is shortened");
    expect(note?.content).toContain("its answer was kept first");
    expect(note?.content).toContain("No round is missing.");
    expect(note?.content).not.toContain("Older");
    expect(note?.content).not.toContain("not here");
  });

  it("says both when both happened", () => {
    const { note, rounds } = clarificationSection([round(1, 2_000), round(2, 9_000)]);
    expect(rounds.filter((part) => part.cutBeforeSend === "whole")).toHaveLength(1);
    expect(rounds.filter((part) => part.cutBeforeSend === "partial")).toHaveLength(1);
    expect(note?.title).toBe(
      "Older clarification rounds left out and the newest shortened",
    );
    expect(note?.content).toBe(
      "[Prompt budget: the oldest of this work's 2 clarification rounds is not here, and the round below is shortened: its answer was kept first and its questions got the room that was left.]\n\n",
    );
  });

  it("keeps the answer whole and shortens the questions, and says so", () => {
    // A 20,000 character question with a short answer. The answer is what a
    // resumed run exists to read, so it survives; the questions get what is
    // left, and the note is what tells the model the question it is reading is
    // not the whole question.
    const { note, rounds, text } = clarificationSection([
      {
        questions: ["q".repeat(20_000)],
        answer: "Only the API.",
        answeredBy: "ops",
        answeredAt: "2026-09-18T09:12:00.000Z",
      },
    ]);
    expect(text).toContain("Only the API.");
    expect(rounds[0]?.cutBeforeSend).toBe("partial");
    expect(note?.content).toContain("the round below is shortened");
  });

  it("holds the section to its budget, plus only what the note costs", () => {
    // The reserve is fixed at what the one old note cost, so what a model reads
    // of the history is byte for byte what it read before; the honest note may
    // be longer than the reserve, and that overshoot is the whole of it.
    for (const clarifications of [
      [1, 2, 3, 4, 5, 6].map((index) => round(index, 1_500)),
      [round(1, 2_000), round(2, 9_000)],
      [round(1, 9_000)],
    ]) {
      const { note, section } = clarificationSection(clarifications);
      expect(note).toBeDefined();
      expect(section.length).toBeGreaterThan(CLARIFICATIONS_MAX_LENGTH - 4_000);
      expect(section.length - (note?.content.length ?? 0)).toBeLessThanOrEqual(
        CLARIFICATIONS_MAX_LENGTH + ROUND_HEADER_AND_FOOTER,
      );
      // A note somebody has to read: one paragraph, never a document.
      expect(note?.content.length).toBeLessThan(260);
    }
  });

  it("renders the same bytes twice", () => {
    const clarifications = [round(1, 2_000), round(2, 9_000)];
    expect(clarificationSection(clarifications).text).toBe(
      clarificationSection(clarifications).text,
    );
  });
});
