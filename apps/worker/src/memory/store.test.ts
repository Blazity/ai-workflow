import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { agentMemoryDocuments } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  MAX_MEMORY_DOCUMENT_BYTES,
  getMemoryDocument,
  listMemoryDocuments,
  upsertMemoryDocument,
} from "./store.js";

const SUBJECT_KEY = "ticket:jira:AIW-177";
const DOC_PATH = "blazebot/memory/AIW-177.md";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

async function countRows(): Promise<number> {
  const rows = await db.select().from(agentMemoryDocuments);
  return rows.length;
}

describe("agent memory document store", () => {
  it("round-trips an inserted document", async () => {
    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: "AIW-177",
      content: "# notes\nzażółć",
      sourceRunId: "run_1",
    });

    const doc = await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH);
    expect(doc?.content).toBe("# notes\nzażółć");
    expect(doc?.bytes).toBe(new TextEncoder().encode("# notes\nzażółć").byteLength);
    expect(doc?.sourceRunId).toBe("run_1");
    expect(doc?.updatedAt).toBeInstanceOf(Date);
  });

  it("overwrites content, bytes and provenance on the same key", async () => {
    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: "AIW-177",
      content: "first",
      sourceRunId: "run_1",
    });
    const [before] = await db.select().from(agentMemoryDocuments);
    // Insert stamps both timestamps from the database clock, the conflict path
    // stamps updated_at from the worker clock; the gap keeps the comparison
    // below strict instead of racing inside one millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: null,
      content: "second pass",
      sourceRunId: "run_2",
    });

    const doc = await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH);
    expect(doc?.content).toBe("second pass");
    expect(doc?.bytes).toBe(11);
    expect(doc?.sourceRunId).toBe("run_2");
    expect(await countRows()).toBe(1);

    const [after] = await db.select().from(agentMemoryDocuments);
    expect(before?.ticketKey).toBe("AIW-177");
    expect(after?.ticketKey).toBeNull();
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
  });

  it("keeps distinct doc paths under one subject key", async () => {
    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: "AIW-177",
      content: "ticket notes",
      sourceRunId: "run_1",
    });
    await upsertMemoryDocument(db, {
      subjectKey: SUBJECT_KEY,
      docPath: "blazebot/memory/lessons.md",
      ticketKey: "AIW-177",
      content: "lessons",
      sourceRunId: "run_1",
    });

    expect(await countRows()).toBe(2);
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe("ticket notes");
    expect(
      (await getMemoryDocument(db, SUBJECT_KEY, "blazebot/memory/lessons.md"))?.content,
    ).toBe("lessons");
  });

  it("rejects content above the size cap without writing", async () => {
    await expect(
      upsertMemoryDocument(db, {
        subjectKey: SUBJECT_KEY,
        docPath: DOC_PATH,
        ticketKey: "AIW-177",
        content: "x".repeat(MAX_MEMORY_DOCUMENT_BYTES + 1),
        sourceRunId: "run_1",
      }),
    ).rejects.toThrow(/size limit/);

    expect(await countRows()).toBe(0);
  });

  it("accepts a null ticket key for PR-triggered runs", async () => {
    await upsertMemoryDocument(db, {
      subjectKey: "pr:github:acme/web#12",
      docPath: "blazebot/memory/pr-12.md",
      ticketKey: null,
      content: "pr notes",
      sourceRunId: "run_1",
    });

    const [row] = await db.select().from(agentMemoryDocuments);
    expect(row?.ticketKey).toBeNull();
    expect(row?.content).toBe("pr notes");
  });

  it("returns null for an unknown key", async () => {
    expect(await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toBeNull();
  });
});

describe("listMemoryDocuments", () => {
  /** Writes documents one at a time so each one gets a distinct updated_at. */
  async function seed(
    docs: { subjectKey: string; docPath: string; ticketKey: string | null; content: string }[],
  ): Promise<void> {
    for (const doc of docs) {
      await upsertMemoryDocument(db, { ...doc, sourceRunId: `run_${doc.docPath}` });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("returns the newest document first", async () => {
    await seed([
      { subjectKey: "ticket:jira:AIW-1", docPath: "a.md", ticketKey: "AIW-1", content: "one" },
      { subjectKey: "ticket:jira:AIW-2", docPath: "b.md", ticketKey: "AIW-2", content: "two" },
      { subjectKey: "ticket:jira:AIW-3", docPath: "c.md", ticketKey: "AIW-3", content: "three" },
    ]);

    const rows = await listMemoryDocuments(db);
    expect(rows.map((row) => row.docPath)).toEqual(["c.md", "b.md", "a.md"]);
    expect(rows[0]?.subjectKey).toBe("ticket:jira:AIW-3");
    expect(rows[0]?.ticketKey).toBe("AIW-3");
    expect(rows[0]?.sourceRunId).toBe("run_c.md");
    expect(rows[0]?.bytes).toBe(5);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("never returns the document content", async () => {
    await seed([
      { subjectKey: SUBJECT_KEY, docPath: DOC_PATH, ticketKey: "AIW-177", content: "secret" },
    ]);

    const [row] = await listMemoryDocuments(db);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("content");
  });

  it("filters by ticket key", async () => {
    await seed([
      { subjectKey: "ticket:jira:AIW-1", docPath: "a.md", ticketKey: "AIW-1", content: "one" },
      { subjectKey: "ticket:jira:AIW-2", docPath: "b.md", ticketKey: "AIW-2", content: "two" },
      { subjectKey: "pr:github:acme/web#12", docPath: "pr.md", ticketKey: null, content: "pr" },
    ]);

    const rows = await listMemoryDocuments(db, { ticketKey: "AIW-2" });
    expect(rows.map((row) => row.docPath)).toEqual(["b.md"]);
    expect(await listMemoryDocuments(db, { ticketKey: "AIW-404" })).toEqual([]);
  });

  it("respects the requested limit", async () => {
    await seed([
      { subjectKey: "ticket:jira:AIW-1", docPath: "a.md", ticketKey: "AIW-1", content: "one" },
      { subjectKey: "ticket:jira:AIW-2", docPath: "b.md", ticketKey: "AIW-2", content: "two" },
      { subjectKey: "ticket:jira:AIW-3", docPath: "c.md", ticketKey: "AIW-3", content: "three" },
    ]);

    expect((await listMemoryDocuments(db, { limit: 2 })).map((row) => row.docPath)).toEqual([
      "c.md",
      "b.md",
    ]);
    // Nonsense limits fall back to the default instead of returning nothing.
    expect(await listMemoryDocuments(db, { limit: 0 })).toHaveLength(3);
    expect(await listMemoryDocuments(db, { limit: -5 })).toHaveLength(3);
    expect(await listMemoryDocuments(db, { limit: 1.5 })).toHaveLength(3);
  });
});
