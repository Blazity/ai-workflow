import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { agentMemoryDocuments } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  MAX_MEMORY_DOCUMENT_BYTES,
  deleteMemoryDocument,
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

describe("optimistic concurrency", () => {
  const REPO_SUBJECT_KEY = "repo:github:acme/web";

  async function write(
    content: string,
    sourceRunId: string,
    expectedVersion?: number,
  ): Promise<{ applied: boolean; version: number | null }> {
    return upsertMemoryDocument(db, {
      subjectKey: REPO_SUBJECT_KEY,
      docPath: "facts",
      ticketKey: null,
      content,
      sourceRunId,
      // Spread so a blind write really omits the key: passing it as undefined
      // throws, which is what keeps the two modes from blurring together.
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  }

  it("starts a fresh document at version 1", async () => {
    const result = await write("first", "run_1");

    expect(result).toEqual({ applied: true, version: 1 });
    expect((await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts"))?.version).toBe(1);
  });

  it("increments the version on a blind upsert and always applies", async () => {
    await write("first", "run_1");

    expect(await write("second", "run_2")).toEqual({ applied: true, version: 2 });
    expect(await write("third", "run_3")).toEqual({ applied: true, version: 3 });

    const doc = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(doc?.content).toBe("third");
    expect(doc?.version).toBe(3);
  });

  it("applies a compare-and-swap that carries the current version", async () => {
    await write("first", "run_1");

    const result = await write("second", "run_2", 1);

    expect(result).toEqual({ applied: true, version: 2 });
    const doc = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(doc?.content).toBe("second");
    expect(doc?.bytes).toBe(6);
    expect(doc?.sourceRunId).toBe("run_2");
  });

  it("rejects a compare-and-swap on a stale version and keeps the winner's content", async () => {
    await write("shared base", "run_1");
    // Both runs read version 1; the first swap wins and the second must not
    // overwrite it with content distilled from the base.
    expect(await write("base plus A", "run_a", 1)).toEqual({ applied: true, version: 2 });

    const loser = await write("base plus B", "run_b", 1);

    expect(loser).toEqual({ applied: false, version: null });
    const doc = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(doc?.content).toBe("base plus A");
    expect(doc?.sourceRunId).toBe("run_a");
    expect(doc?.version).toBe(2);
  });

  it("creates the row when expectedVersion is 0 and nothing exists", async () => {
    const result = await write("created", "run_1", 0);

    expect(result).toEqual({ applied: true, version: 1 });
    expect((await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts"))?.content).toBe("created");
  });

  it("leaves an existing row untouched when expectedVersion is 0", async () => {
    await write("already here", "run_1");

    const result = await write("late creator", "run_2", 0);

    expect(result).toEqual({ applied: false, version: null });
    const doc = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(doc?.content).toBe("already here");
    expect(doc?.sourceRunId).toBe("run_1");
    expect(doc?.version).toBe(1);
    expect(await countRows()).toBe(1);
  });

  it("lets a blind writer invalidate a compare-and-swap holder's version", async () => {
    await write("shared base", "run_1");
    // Transitional state: a converted writer holds version 1 while an
    // unconverted one still takes the blind branch and moves the row past it.
    expect(await write("blind overwrite", "run_blind")).toEqual({ applied: true, version: 2 });

    const cas = await write("base plus CAS", "run_cas", 1);

    expect(cas).toEqual({ applied: false, version: null });
    const doc = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(doc?.content).toBe("blind overwrite");
    expect(doc?.version).toBe(2);
  });

  it("throws when expectedVersion is present but undefined", async () => {
    await expect(
      upsertMemoryDocument(db, {
        subjectKey: REPO_SUBJECT_KEY,
        docPath: "facts",
        ticketKey: null,
        content: "ambiguous",
        sourceRunId: "run_1",
        expectedVersion: undefined,
      }),
    ).rejects.toThrow(/expectedVersion: undefined/);

    expect(await countRows()).toBe(0);
  });

  it("rejects a compare-and-swap against a document that does not exist", async () => {
    expect(await write("nothing to swap", "run_1", 1)).toEqual({ applied: false, version: null });
    expect(await countRows()).toBe(0);
  });

  it("rejects content above the size cap before touching the version", async () => {
    await write("first", "run_1");

    await expect(write("x".repeat(MAX_MEMORY_DOCUMENT_BYTES + 1), "run_2", 1)).rejects.toThrow(
      /size limit/,
    );

    const doc = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(doc?.content).toBe("first");
    expect(doc?.version).toBe(1);
  });
});

describe("deleteMemoryDocument", () => {
  async function seed(subjectKey: string, docPath: string, content = "remembered"): Promise<void> {
    await upsertMemoryDocument(db, {
      subjectKey,
      docPath,
      ticketKey: null,
      content,
      sourceRunId: "run_1",
    });
  }

  it("removes the row and reports the removal", async () => {
    await seed(SUBJECT_KEY, DOC_PATH, "sensitive text");

    expect(await deleteMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toBe(true);

    expect(await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toBeNull();
    expect(await countRows()).toBe(0);
    // A hard delete, not a flag: nothing in the table may still carry the text.
    const rows = await db.select().from(agentMemoryDocuments);
    expect(rows).toEqual([]);
  });

  it("reports no removal for a key that was never stored", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);

    expect(await deleteMemoryDocument(db, SUBJECT_KEY, "blazebot/memory/other.md")).toBe(false);
    expect(await deleteMemoryDocument(db, "ticket:jira:AIW-404", DOC_PATH)).toBe(false);
    expect(await countRows()).toBe(1);
  });

  it("reports no removal on a second delete of the same key", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);

    expect(await deleteMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toBe(true);
    expect(await deleteMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toBe(false);
  });

  it("deletes only the full primary key, never every doc path of a subject", async () => {
    await seed(SUBJECT_KEY, DOC_PATH, "target");
    await seed(SUBJECT_KEY, "blazebot/memory/lessons.md", "sibling");
    await seed("repo:github:acme/web", DOC_PATH, "same path, other subject");

    expect(await deleteMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toBe(true);

    expect(await countRows()).toBe(2);
    expect(
      (await getMemoryDocument(db, SUBJECT_KEY, "blazebot/memory/lessons.md"))?.content,
    ).toBe("sibling");
    expect((await getMemoryDocument(db, "repo:github:acme/web", DOC_PATH))?.content).toBe(
      "same path, other subject",
    );
  });

  it("treats SQL metacharacters as literal key text", async () => {
    await seed(SUBJECT_KEY, DOC_PATH, "keep me");
    const hostileSubject = "ticket:jira:AIW-177'; DROP TABLE agent_memory_documents; --";
    const hostilePath = "a.md' OR '1'='1";
    await seed(hostileSubject, hostilePath, "hostile key, real row");

    // The injection-shaped key deletes exactly its own row and nothing else.
    expect(await deleteMemoryDocument(db, hostileSubject, hostilePath)).toBe(true);
    expect(await countRows()).toBe(1);
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe("keep me");

    // The same shape against a key nobody stored matches nothing at all.
    expect(await deleteMemoryDocument(db, "' OR 1=1 --", "' OR 1=1 --")).toBe(false);
    expect(await countRows()).toBe(1);
  });

  it("matches nothing for oversized or traversal-shaped keys", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);

    expect(await deleteMemoryDocument(db, "x".repeat(100_000), "y".repeat(100_000))).toBe(false);
    expect(await deleteMemoryDocument(db, SUBJECT_KEY, "../../blazebot/memory/AIW-177.md")).toBe(
      false,
    );
    expect(await deleteMemoryDocument(db, SUBJECT_KEY, `blazebot/memory/../${"AIW-177.md"}`)).toBe(
      false,
    );
    expect(await deleteMemoryDocument(db, SUBJECT_KEY, "%")).toBe(false);
    expect(await deleteMemoryDocument(db, "%", "%")).toBe(false);
    expect(await countRows()).toBe(1);
  });

  it("drops a document from the listing once it is deleted", async () => {
    await seed(SUBJECT_KEY, DOC_PATH);
    await seed("ticket:jira:AIW-9", "blazebot/memory/AIW-9.md");

    await deleteMemoryDocument(db, SUBJECT_KEY, DOC_PATH);

    expect((await listMemoryDocuments(db)).map((row) => row.docPath)).toEqual([
      "blazebot/memory/AIW-9.md",
    ]);
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
