import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { listClarificationAnswerDeliveryRows } from "../../db/repositories/agent-visibility.js";
import { clarificationRequests } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { logger } from "../../infra/logger.js";
import {
  createVisibilityDetector,
  VisibilityCaptureRefusal,
} from "../../run-observability/visibility-detector.js";
import { recordAnswerDelivery } from "./index.js";

const SECRET = "cfg-secret-7Qx9";
const CLARIFICATION = "clarification-1";
const RUN = "wrun_delivery";
const sanitize = createVisibilityDetector({ secrets: [SECRET] });

let db: Db;

beforeEach(async () => {
  vi.restoreAllMocks();
  db = await createTestDb();
  await db.insert(clarificationRequests).values({
    id: CLARIFICATION,
    runId: RUN,
    questions: ["Which repositories?"],
    status: "pending",
  });
});

describe("recordAnswerDelivery", () => {
  // Red when: a person pastes a credential into an answer, or a model's
  // paraphrase quotes one back, and it lands in a row the dashboard and MCP
  // both serve.
  it("keeps no secret, token or control character in what it stores", async () => {
    const result = await recordAnswerDelivery(
      {
        clarificationId: CLARIFICATION,
        runId: RUN,
        words: `use ${SECRET} and ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}\u0000`,
        author: { kind: "person", display: `Ada ${SECRET}` },
        surface: "dashboard",
        reading: {
          version: 1,
          outcome: { kind: "unclear", paraphrase: `they wrote ${SECRET}` },
          readBy: "model",
          model: "claude-sonnet-4-5-20250929",
          readAt: "2026-09-19T10:00:00.000Z",
          unofferedNames: [SECRET],
        },
        note: `I could not read ${SECRET}.`,
        at: new Date("2026-09-19T10:00:00.000Z"),
      },
      { db, sanitize },
    );

    expect(result).toEqual({ outcome: "appended" });
    const [row] = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row).toMatchObject({
      words: "use [REDACTED] and [REDACTED]",
      authorDisplay: "Ada [REDACTED]",
      note: "I could not read [REDACTED].",
    });
    expect(row!.reading).toMatchObject({
      outcome: { kind: "unclear", paraphrase: "they wrote [REDACTED]" },
      unofferedNames: ["[REDACTED]"],
    });
  });

  // Red when: a delivery that cannot be written throws into the answer path,
  // where it would change a person's answer into a failure.
  it("logs and returns when the row cannot be written", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const broken = { execute: () => Promise.reject(new Error("relation does not exist")) } as unknown as Db;

    const result = await recordAnswerDelivery(
      {
        clarificationId: CLARIFICATION,
        runId: RUN,
        words: "github:acme/api",
        author: { kind: "person", display: "Ada" },
        surface: "dashboard",
        reading: null,
        note: null,
      },
      { db: broken, sanitize },
    );

    expect(result).toEqual({ outcome: "not_recorded", reason: "relation does not exist" });
    // THE IDENTITY, NOT THE PAYLOAD: a failed statement's message carries its
    // own SQL and parameters, and the parameters here are what a person wrote.
    expect(warn).toHaveBeenCalledWith(
      {
        runId: RUN,
        clarificationId: CLARIFICATION,
        surface: "dashboard",
        err: "Error",
        code: undefined,
      },
      "clarification_answer_delivery_failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("relation does not exist");
  });

  // Red when: a field the detector cannot prove clean takes the whole arrival
  // with it, so a person who answered has no row at all and the round says
  // nobody answered.
  it("stores the marker for a field it cannot prove clean, and keeps the arrival", async () => {
    const refusing = (text: string) => {
      if (text.includes("unprovable")) throw new VisibilityCaptureRefusal("nothing could be proven clean");
      return [];
    };

    const result = await recordAnswerDelivery(
      {
        clarificationId: CLARIFICATION,
        runId: RUN,
        words: "an unprovable answer",
        author: { kind: "person", display: "Ada" },
        surface: "jira",
        reading: null,
        note: "told them",
      },
      { db, sanitize: refusing },
    );

    expect(result).toEqual({ outcome: "appended" });
    const [row] = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(row).toMatchObject({ words: "[REDACTED]", authorDisplay: "Ada", note: "told them" });
  });

  // Red when: a half character a channel cut in two (a Jira comment cut at ten
  // thousand characters) makes the write fail instead of being stored as the
  // replacement every reader shows.
  it("stores words a channel cut through a character", async () => {
    const result = await recordAnswerDelivery(
      {
        clarificationId: CLARIFICATION,
        runId: RUN,
        words: "cut here \uD83D",
        author: { kind: "several_people", display: "Ada, Bo (via Jira)" },
        surface: "jira",
        reading: null,
        note: null,
      },
      { db, sanitize },
    );

    expect(result).toEqual({ outcome: "appended" });
    const [row] = await listClarificationAnswerDeliveryRows(db, [CLARIFICATION]);
    expect(row).toMatchObject({ words: "cut here �", authorKind: "several_people" });
  });
});
