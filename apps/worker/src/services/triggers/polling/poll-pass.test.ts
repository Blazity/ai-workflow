import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D9 / row R05. What the tick says when the catalog read fails.
 *
 * The reader is extracted from `runPollPass` precisely so this is testable:
 * the pass itself reaches half the deployment, while the behaviour worth
 * pinning is one object. Fail-closed was already right (a dispatch phase
 * without a catalog must dispatch nothing); what was wrong is that it was also
 * silent, so "dispatch stopped for a tick" left nothing in the log an alert
 * could fire on.
 */
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../../infra/logger.js", () => ({ logger }));
// The pass reaches half the deployment, so importing it parses the worker's
// environment. Nothing below the reader is exercised here; this only keeps the
// import from demanding a configured deployment.
vi.mock("../../../infra/vcs-config.js", () => ({ env: {} }));

const { createRepositoryCatalogReader } = await import("./poll-pass.js");

// The snapshot's shape is irrelevant here: what is tested is whether the reader
// hands one over or refuses, and what it says when it refuses.
const SNAPSHOT = { activated: true, entries: [] } as unknown as Awaited<
  ReturnType<Parameters<typeof createRepositoryCatalogReader>[0]>
>;

function errorEvents(name: string) {
  return logger.error.mock.calls.filter((call) => call[1] === name);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createRepositoryCatalogReader", () => {
  it("hands every phase the snapshot and logs nothing while the read works", async () => {
    const reader = createRepositoryCatalogReader(async () => SNAPSHOT);

    expect(await reader.read("dispatch")).toBe(SNAPSHOT);
    expect(await reader.read("recovery")).toBe(SNAPSHOT);

    expect(logger.error).not.toHaveBeenCalled();
    expect(reader.outcome()).toBe("ok");
  });

  it("says nothing at all about a tick where no phase had a dispatch decision", () => {
    const load = vi.fn();
    const reader = createRepositoryCatalogReader(load as never);

    // Clarification expiry, the at-capacity queue, the rate sweeps and the
    // stall backstop never ask, and an untouched table is not an incident.
    expect(reader.outcome()).toBe("not_needed");
    expect(load).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs the failed read at error level with its message and stack, and refuses the phase", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const reader = createRepositoryCatalogReader(async () => {
      throw boom;
    });

    expect(await reader.read("ticket_dispatch")).toBeNull();

    const failed = errorEvents("poll_repository_catalog_load_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.[0]).toMatchObject({
      phase: "ticket_dispatch",
      error: "connection terminated unexpectedly",
    });
    expect(failed[0]?.[0]).toHaveProperty("stack", boom.stack);
    // Warn was the old level, and nothing pages on a warn.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("names every phase it skips, including the one whose read failed", async () => {
    const boom = new Error("catalog unreachable");
    const load = vi.fn(async () => {
      throw boom;
    });
    const reader = createRepositoryCatalogReader(load);

    expect(await reader.read("ticket_dispatch")).toBeNull();
    expect(await reader.read("schedule_trigger")).toBeNull();
    expect(await reader.read("webhook_trigger")).toBeNull();

    // One failed read, not three: the failure is remembered rather than retried
    // per phase.
    expect(load).toHaveBeenCalledTimes(1);
    const skipped = errorEvents("poll_repository_catalog_skipped");
    expect(skipped.map((call) => (call[0] as { phase: string }).phase)).toEqual([
      "ticket_dispatch",
      "schedule_trigger",
      "webhook_trigger",
    ]);
    // Every skip carries the cause, so the line that fires the alert is also
    // the line that explains it.
    for (const call of skipped) {
      expect(call[0]).toMatchObject({ error: "catalog unreachable" });
      expect(call[0]).toHaveProperty("stack", boom.stack);
    }
  });

  it("reports the failure on the tick result, so the run summary shows it", async () => {
    const reader = createRepositoryCatalogReader(async () => {
      throw new Error("nope");
    });

    await reader.read("ticket_dispatch");

    expect(reader.outcome()).toBe("failed");
  });

  it("carries a thrown non-Error through as text rather than losing it", async () => {
    // A driver that fails with a string rather than an Error. The cast is the
    // shape the linter insists on and the reality this branch has to survive:
    // `error.message` on it is undefined, which is exactly why the reader
    // stringifies instead of reading it.
    const notAnError = "the pool is closed" as unknown as Error;
    const reader = createRepositoryCatalogReader(async () => {
      throw notAnError;
    });

    await reader.read("ticket_dispatch");

    expect(errorEvents("poll_repository_catalog_load_failed")[0]?.[0]).toMatchObject({
      error: "the pool is closed",
      stack: undefined,
    });
  });
});
