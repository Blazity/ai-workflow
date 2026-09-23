/**
 * How long a page an integration contributes waits on its provider, and what a
 * person reads when the provider does not answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolution = vi.hoisted(() => ({
  delayMs: 0,
  /** The database did not answer when the resolver read the settings. */
  unreadable: null as string | null,
  read: (async () => ({})) as (ctx: { signal?: AbortSignal }) => Promise<unknown>,
}));

vi.mock("@integrations/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@integrations/registry")>()),
  integrationManifest: (id: string) =>
    id === "acme" ? { id: "acme", name: "Acme", pages: [{ id: "usage", label: "Usage" }] } : undefined,
}));
vi.mock("@integrations/registry/worker", () => ({
  integrationRuntime: (id: string) => (id === "acme" ? { api: { usage: () => ({}) } } : undefined),
}));
vi.mock("../../infra/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("./usable.js", () => ({
  resolveUsableIntegrations: async (input: { lifetime?: AbortSignal }) => {
    await new Promise((resolve) => setTimeout(resolve, resolution.delayMs));
    if (resolution.unreadable !== null) return { readable: false, reason: resolution.unreadable };
    return {
      readable: true,
      states: new Map(),
      connectionFailures: new Map(),
      usable: [
        {
          manifest: { id: "acme", name: "Acme" },
          runtime: { api: { usage: (ctx: { signal?: AbortSignal }) => resolution.read(ctx) } },
          ctx: { signal: input.lifetime },
        },
      ],
    };
  },
}));

const { readIntegrationPageData } = await import("./page-data.js");

/** A provider that answers after `ms`, or gives up when its lifetime ends. */
function answersAfter(ms: number) {
  return (ctx: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ rows: 3 }), ms);
      ctx.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(ctx.signal?.reason ?? new Error("The operation was aborted due to timeout"));
      });
    });
}

beforeEach(() => {
  vi.useFakeTimers();
  resolution.delayMs = 0;
  resolution.unreadable = null;
  // `AbortSignal.timeout` runs on the runtime's own clock, which the fake
  // timers do not move; a budget built on it is put on the same clock here,
  // so every reader is measured by the one clock the test advances.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a contributed page waiting on its provider", () => {
  it("says the provider did not answer in time, in a sentence", async () => {
    resolution.read = answersAfter(60_000);
    const pending = readIntegrationPageData("acme", "usage");
    // The reader imports what it needs on first use; the clock only means
    // something once those have loaded and the timers exist.
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(20_001);

    expect(await pending).toEqual({
      status: "unavailable",
      cause: "provider",
      reason: "Acme did not answer within 20 seconds.",
    });
  });

  it("does not spend the provider's time on resolving the connection", async () => {
    // A slow database read before the call used to come off the provider's
    // twenty seconds, so an 18 second provider was cut off and blamed.
    resolution.delayMs = 3_000;
    resolution.read = answersAfter(18_000);
    const pending = readIntegrationPageData("acme", "usage");
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(21_500);

    expect(await pending).toEqual({ status: "ok", value: { rows: 3 } });
  });

  it("says our side could not read its settings, never that the integration is not connected", async () => {
    // A database that did not answer for a moment is not an integration that
    // is off: "not connected" sent a person to the Connection tab to fix a
    // connection that works.
    resolution.unreadable = "connection terminated unexpectedly";
    const pending = readIntegrationPageData("acme", "usage");
    await vi.dynamicImportSettled();
    await vi.runAllTimersAsync();

    const result = await pending;
    expect(result).toMatchObject({ status: "unavailable", cause: "worker" });
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toContain("integration settings could not be read");
    expect(result.reason).not.toContain("not connected");
    // The database's own words are logged where the read failed, never put
    // in front of a person.
    expect(result.reason).not.toContain("connection terminated");
  });
});
