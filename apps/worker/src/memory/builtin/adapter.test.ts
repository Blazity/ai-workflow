/**
 * The built-in provider's own answers, on the questions only it decides.
 *
 * The step suites already drive it end to end (compare and swap, contention,
 * redaction, eviction under cap pressure, the notebook's dual read). What is
 * here is what the port asks of a provider and no caller can check for it: that
 * it never throws, that "I hold nothing" and "it rendered to nothing" are two
 * different answers, and that forgetting on request never costs more than what
 * was asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  // What this deployment knows as secret. Stated here rather than read from the
  // connection tables: these cases break the database on purpose.
  secrets: (async () => []) as () => Promise<string[]>,
}));
vi.mock("../../db/client.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/integrations/runtime.js")>()),
  knownSecretValues: () => mocks.secrets(),
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn() }), warn: vi.fn(), info: vi.fn() },
}));

import { createTestDb } from "../../db/test-db.js";
import { getMemoryDocument, upsertMemoryDocument } from "../../db/repositories/memory.js";
import { renderRepoMemoryDocument } from "../repo-memory.js";
import { builtinMemoryAdapter } from "./adapter.js";

const SUBJECT = { key: "repo:github:acme/api", label: "acme/api" };
/** One adapter per test, as a step gets one per resolution: it keeps the
 *  secret set it read, so a case that changes the set needs a fresh one. */
let memory: ReturnType<typeof builtinMemoryAdapter>;

async function store(items: string[], runId = "run_0"): Promise<void> {
  await upsertMemoryDocument(mocks.db as never, {
    subjectKey: SUBJECT.key,
    docPath: "facts",
    ticketKey: null,
    content: renderRepoMemoryDocument({
      subject: SUBJECT.label,
      kind: "facts",
      items: items.map((text) => ({ text, runId })),
    }),
    sourceRunId: runId,
  });
}

/** The real select off the test database, so a stub can break the write half
 *  only. A write that fails after the read is the case worth separating. */
function selectOf(db: unknown): unknown {
  const real = db as { select: (...args: unknown[]) => unknown };
  return real.select.bind(real);
}

beforeEach(async () => {
  mocks.db = await createTestDb();
  mocks.secrets = async () => [];
  memory = builtinMemoryAdapter();
});

describe("recall", () => {
  it("answers held for a subject whose document renders to nothing", async () => {
    // A document with a header and no items is not the same thing as a subject
    // nobody has written to. Reading one for the other is what makes a
    // deterministic seed create a document on top of one a run emptied.
    await store([]);

    const recalled = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });

    expect(recalled).toEqual({ ok: true, held: true, entries: [], rendering: "" });
  });

  it("answers not held for a subject nothing was ever written for", async () => {
    const recalled = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });

    expect(recalled).toEqual({ ok: true, held: false, entries: [], rendering: "" });
  });

  it("answers instead of throwing when the database is gone", async () => {
    // The port promises not to throw, and memory is reached from teardown and
    // from a poll pass, where a throw costs work that has nothing to do with it.
    mocks.db = {
      select: () => {
        throw new Error("db down");
      },
    };

    const recalled = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });

    expect(recalled).toEqual({
      ok: false,
      code: "unavailable",
      detail: expect.stringContaining("db down"),
    });
  });
});

describe("observe", () => {
  it("forgets only what a retraction named, even past what it would accept as new", async () => {
    // THE RULE THIS PROVIDER INVENTED, and the case that made it necessary. A
    // document stored under an older, larger cap holds more than this store
    // would accept today. A run that meant to delete one stale line must not
    // also delete everything beyond the bound: nobody asked for that, and the
    // next observation that actually adds something trims it anyway.
    const stored = Array.from({ length: 60 }, (_, index) => `fact ${index}`);
    await store(["stale fact", ...stored]);

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: [], refuted: ["stale fact"] },
    });

    expect(write).toMatchObject({ ok: true, stored: true, removed: 1, dropped: 0 });
    const after = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });
    expect(after.ok && after.entries.map((entry) => entry.text)).toEqual(stored);
  });

  it("evicts down to what it holds once an observation adds something", async () => {
    // The other half of the same rule: a write that asserts is a write this
    // store sizes, so an over-cap document is trimmed then and not before.
    const stored = Array.from({ length: 60 }, (_, index) => `fact ${index}`);
    await store(stored);

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: ["one new fact"], refuted: [] },
    });

    expect(write).toMatchObject({ ok: true, stored: true, remaining: 40 });
  });

  it("creates only, and keeps out of a document somebody else already wrote", async () => {
    await store(["a fact a run distilled"]);

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: {
        kind: "items",
        learned: ["Package manager is pnpm"],
        refuted: [],
        derived: true,
        onlyIfEmpty: true,
      },
    });

    expect(write).toMatchObject({ ok: true, stored: false });
    const after = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });
    expect(after.ok && after.entries.map((entry) => entry.text)).toEqual([
      "a fact a run distilled",
    ]);
  });

  it("refuses items for a notebook rather than inventing a merge for it", async () => {
    // The agent is a notebook's only author, so there is nothing to reconcile.
    // Refusing says which caller is wrong; merging would quietly rewrite what
    // the agent wrote.
    const write = await memory.observe({
      subject: { key: "ticket:jira:AIW-1", label: "AIW-1" },
      scope: { kind: "notebook", name: "AIW-1" },
      runId: "run_1",
      ticketKey: "AIW-1",
      observation: { kind: "items", learned: ["a fact"], refuted: [] },
    });

    expect(write).toMatchObject({ ok: false, code: "rejected" });
  });

  it("calls a document this store will never accept rejected, not unavailable", async () => {
    // The SDK says `unavailable` is worth retrying. A document past the size
    // cap will be refused every time, and the distill pays for a model call
    // before each attempt, so the wrong code sends a caller back to spend the
    // same money on the same refusal.
    mocks.db = {
      select: selectOf(mocks.db),
      insert: () => {
        throw Object.assign(new Error("exceeds the memory document size limit"), {
          code: "memory_document_too_large",
        });
      },
    };

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: ["a fact"], refuted: [] },
    });

    expect(write).toMatchObject({ ok: false, code: "rejected" });
  });

  it("still calls an unreachable database unavailable", async () => {
    // The positive control for the line above: everything else on this path
    // stays worth retrying, or the fix has traded one wrong code for another.
    mocks.db = {
      select: selectOf(mocks.db),
      insert: () => {
        throw new Error("db down");
      },
    };

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: ["a fact"], refuted: [] },
    });

    expect(write).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("a secret it learned after storing it", () => {
  // A value can reach memory before it is a known secret: an environment
  // variable added later, a token pasted into the dashboard later. Core cleans
  // everything it sends; only this store can clean what it already holds.
  const TOKEN = "stored-dashboard-token-5e1f0c";
  const CLEANED = "[REDACTED:configured_secret]";

  async function storedText(): Promise<string | undefined> {
    return (await getMemoryDocument(mocks.db as never, SUBJECT.key, "facts"))?.content;
  }

  it("takes it out of what it holds at the next write", async () => {
    await store([`Deploy with ${TOKEN} in the header`]);
    mocks.secrets = async () => [TOKEN];

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: ["Run tests with pnpm test"], refuted: [] },
    });

    expect(write).toMatchObject({ ok: true, stored: true });
    expect(await storedText()).not.toContain(TOKEN);
    expect(await storedText()).toContain(`Deploy with ${CLEANED} in the header`);
  });

  it("takes it out even when the run only confirmed what was there", async () => {
    // Confirming an item is otherwise a write only when provenance moves; a
    // held secret is a change worth writing on its own.
    await store([`Deploy with ${TOKEN} in the header`], "run_1");
    mocks.secrets = async () => [TOKEN];

    await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: [], refuted: [] },
    });

    expect(await storedText()).not.toContain(TOKEN);
  });

  it("still forgets such an item when a run disproves it", async () => {
    // Core cleans `refuted` as well, so the run names the item cleaned. Matched
    // against the raw stored copy, the retraction would silently miss.
    await store([`The token ${TOKEN} is read from .env`, "Package manager is pnpm"]);
    mocks.secrets = async () => [TOKEN];

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: [], refuted: [`The token ${CLEANED} is read from .env`] },
    });

    expect(write).toMatchObject({ ok: true, stored: true, removed: 1 });
    const after = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });
    expect(after.ok && after.entries.map((entry) => entry.text)).toEqual(["Package manager is pnpm"]);
  });

  it("writes nothing when the secrets to take out cannot be read", async () => {
    await store([`Deploy with ${TOKEN} in the header`]);
    const before = await storedText();
    const { IntegrationSettingsUnreadableError } = await import(
      "../../services/integrations/secret-values.js"
    );
    mocks.secrets = async () => {
      throw new IntegrationSettingsUnreadableError("so the secrets they hold could not be redacted", new Error("db down"));
    };

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: ["Run tests with pnpm test"], refuted: [] },
    });

    expect(write).toMatchObject({ ok: false, code: "unavailable" });
    expect(await storedText()).toBe(before);
  });
});

describe("a create-only write", () => {
  it("answers already there without needing the secret set", async () => {
    // Nothing held is merged into, so nothing held needs cleaning: a seed that
    // finds a document says so even when the set cannot be read.
    await store(["a fact a run distilled"]);
    const { IntegrationSettingsUnreadableError } = await import(
      "../../services/integrations/secret-values.js"
    );
    mocks.secrets = async () => {
      throw new IntegrationSettingsUnreadableError("so the secrets they hold could not be redacted", new Error("db down"));
    };

    const write = await memory.observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: {
        kind: "items",
        learned: ["Package manager is pnpm"],
        refuted: [],
        derived: true,
        onlyIfEmpty: true,
      },
    });

    expect(write).toEqual({ ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 });
  });
});

describe("the admin half", () => {
  it("says a listing the store's cap cut short is not everything it holds", async () => {
    // `complete` was hardcoded true here, so a deployment past the cap showed a
    // short table with no notice and told an MCP client the list was the whole
    // store, after the tool catalog had told that client to trust this field
    // before concluding anything from what is missing.
    for (let index = 0; index < 3; index += 1) {
      await upsertMemoryDocument(mocks.db as never, {
        subjectKey: `ticket:jira:AIW-${index}`,
        docPath: `${index}.md`,
        ticketKey: `AIW-${index}`,
        content: "x",
        sourceRunId: `run_${index}`,
      });
    }

    const admin = memory.store;
    expect(admin).toBeDefined();
    const cut = await admin!.list({ limit: 2 });
    expect(cut.documents).toHaveLength(2);
    expect(cut.complete).toBe(false);

    const whole = await admin!.list({});
    expect(whole.documents).toHaveLength(3);
    expect(whole.complete).toBe(true);
  });
});
