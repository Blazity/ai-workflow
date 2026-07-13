import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { PostgresRunRegistry } from "./postgres.js";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";

let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  db = await createTestDb();
  registry = new PostgresRunRegistry(db);
});

describe("claim", () => {
  it("returns true when the ticket is unclaimed", async () => {
    expect(await registry.claim("PROJ-1", "claiming")).toBe(true);
    expect(await registry.getRunId("PROJ-1")).toBe("claiming");
  });

  it("returns false when the ticket is already claimed", async () => {
    await registry.claim("PROJ-1", "claiming");
    expect(await registry.claim("PROJ-1", "other")).toBe(false);
    expect(await registry.getRunId("PROJ-1")).toBe("claiming");
  });

  it("stamps a creation timestamp", async () => {
    const before = Date.now();
    await registry.claim("PROJ-1", "claiming");
    const ts = await registry.getEntryCreatedAt("PROJ-1");
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("returns true again after unregister frees the slot", async () => {
    await registry.claim("PROJ-1", "run_a");
    await registry.unregister("PROJ-1");
    expect(await registry.claim("PROJ-1", "run_b")).toBe(true);
    expect(await registry.getRunId("PROJ-1")).toBe("run_b");
  });
});

describe("register", () => {
  it("overwrites the runId after a claim", async () => {
    await registry.claim("PROJ-1", "claiming");
    await registry.register("PROJ-1", "run_abc");
    expect(await registry.getRunId("PROJ-1")).toBe("run_abc");
  });

  it("inserts when no claim exists (external seeders)", async () => {
    await registry.register("PROJ-2", "run_xyz");
    expect(await registry.getRunId("PROJ-2")).toBe("run_xyz");
  });

  it("REFRESHES the creation timestamp (authoritative write point — reconcile orphan grace period)", async () => {
    await registry.claim("PROJ-1", "claiming");
    // Backdate the entry past any grace window, as if claimed long ago.
    await db.execute(
      sql`UPDATE active_runs SET created_at = now() - interval '10 minutes' WHERE ticket_key = 'PROJ-1'`,
    );
    const stale = await registry.getEntryCreatedAt("PROJ-1");
    expect(Date.now() - stale!).toBeGreaterThan(9 * 60 * 1000);

    await registry.register("PROJ-1", "run_abc");
    const fresh = await registry.getEntryCreatedAt("PROJ-1");
    expect(Date.now() - fresh!).toBeLessThan(60 * 1000);
  });

  it("does not clobber a registered sandboxId", async () => {
    await registry.claim("PROJ-1", "claiming");
    await registry.registerSandbox("PROJ-1", "sbox_1");
    await registry.register("PROJ-1", "run_abc");
    expect(await registry.getSandboxId("PROJ-1")).toBe("sbox_1");
  });
});

describe("getRunId", () => {
  it("returns null when not registered", async () => {
    expect(await registry.getRunId("PROJ-99")).toBeNull();
  });
});

describe("unregister", () => {
  it("removes run, sandbox, and timestamp together", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.registerSandbox("PROJ-1", "sbox_1");
    await registry.unregister("PROJ-1");
    expect(await registry.getRunId("PROJ-1")).toBeNull();
    expect(await registry.getSandboxId("PROJ-1")).toBeNull();
    expect(await registry.getEntryCreatedAt("PROJ-1")).toBeNull();
  });

  it("does NOT touch thread parents (they outlive runs)", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.setParent("PROJ-1", "1700000000.000123");
    await registry.unregister("PROJ-1");
    expect(await registry.getParent("PROJ-1")).toBe("1700000000.000123");
  });
});

describe("listAll", () => {
  it("returns all ticket -> runId pairs", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.claim("PROJ-2", "run_def");
    const all = await registry.listAll();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual({ ticketKey: "PROJ-1", runId: "run_abc", kind: "ticket" });
    expect(all).toContainEqual({ ticketKey: "PROJ-2", runId: "run_def", kind: "ticket" });
  });

  it("returns empty array when none registered", async () => {
    expect(await registry.listAll()).toEqual([]);
  });
});

describe("run kind", () => {
  it("defaults to 'ticket' when claim omits kind", async () => {
    await registry.claim("PROJ-1", "run_abc");
    const [entry] = await registry.listAll();
    expect(entry.kind).toBe("ticket");
  });

  it("round-trips a 'pr_trigger' kind through claim", async () => {
    await registry.claim("PROJ-1", "claiming", "pr_trigger");
    const [entry] = await registry.listAll();
    expect(entry).toEqual({ ticketKey: "PROJ-1", runId: "claiming", kind: "pr_trigger" });
  });

  it("register carries the kind through the claim -> runId swap", async () => {
    await registry.claim("PROJ-1", "claiming", "pr_trigger");
    await registry.register("PROJ-1", "run_abc", "pr_trigger");
    const [entry] = await registry.listAll();
    expect(entry).toEqual({ ticketKey: "PROJ-1", runId: "run_abc", kind: "pr_trigger" });
  });

  it("register defaults to 'ticket' when kind omitted", async () => {
    await registry.register("PROJ-2", "run_xyz");
    const [entry] = await registry.listAll();
    expect(entry.kind).toBe("ticket");
  });
});

describe("sandbox", () => {
  it("registerSandbox/getSandboxId round-trips", async () => {
    await registry.claim("PROJ-1", "run_abc");
    await registry.registerSandbox("PROJ-1", "sbox_12345");
    expect(await registry.getSandboxId("PROJ-1")).toBe("sbox_12345");
  });

  it("getSandboxId returns null when never registered", async () => {
    await registry.claim("PROJ-1", "run_abc");
    expect(await registry.getSandboxId("PROJ-1")).toBeNull();
  });

  it("registerSandbox throws when there is no active run row", async () => {
    // A zero-row update means the run was unregistered out from under us;
    // fail fast so the sandbox isn't silently orphaned (no row links it).
    await expect(
      registry.registerSandbox("PROJ-77", "sbox_orphan"),
    ).rejects.toThrow("no active run for PROJ-77");
    expect(await registry.getSandboxId("PROJ-77")).toBeNull();
    expect(await registry.getRunId("PROJ-77")).toBeNull();
  });
});

describe("failed tickets", () => {
  const meta = {
    runId: "run_abc",
    error: "Failed to move ticket to backlog: 403 Forbidden",
    failedAt: "2026-04-02T12:34:56.000Z",
  };

  it("markFailed/isTicketFailed/listAllFailed round-trips meta exactly", async () => {
    await registry.markFailed("AWT-42", meta);
    expect(await registry.isTicketFailed("AWT-42")).toBe(true);
    expect(await registry.listAllFailed()).toEqual([
      { ticketKey: "AWT-42", meta },
    ]);
  });

  it("markFailed twice updates rather than throwing", async () => {
    await registry.markFailed("AWT-42", meta);
    await registry.markFailed("AWT-42", { ...meta, error: "second" });
    const [entry] = await registry.listAllFailed();
    expect(entry.meta.error).toBe("second");
  });

  it("isTicketFailed returns false / listAllFailed empty when none", async () => {
    expect(await registry.isTicketFailed("AWT-99")).toBe(false);
    expect(await registry.listAllFailed()).toEqual([]);
  });

  it("clearFailedMark removes the marker", async () => {
    await registry.markFailed("AWT-42", meta);
    await registry.clearFailedMark("AWT-42");
    expect(await registry.isTicketFailed("AWT-42")).toBe(false);
  });
});

describe("ThreadStore", () => {
  it("setParent/getParent round-trips a Slack ts as a STRING", async () => {
    await registry.setParent("AWT-42", "1777542341.966359");
    const result = await registry.getParent("AWT-42");
    expect(result).toBe("1777542341.966359");
    expect(typeof result).toBe("string");
  });

  it("setParent overwrites a prior value", async () => {
    await registry.setParent("AWT-42", "111.000");
    await registry.setParent("AWT-42", "222.000");
    expect(await registry.getParent("AWT-42")).toBe("222.000");
  });

  it("getParent returns null when no entry", async () => {
    expect(await registry.getParent("AWT-99")).toBeNull();
  });

  it("clearParent deletes the entry", async () => {
    await registry.setParent("AWT-42", "1700000000.000123");
    await registry.clearParent("AWT-42");
    expect(await registry.getParent("AWT-42")).toBeNull();
  });
});
