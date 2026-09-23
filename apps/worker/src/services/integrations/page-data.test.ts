/**
 * How long a page an integration contributes waits on its provider, and what a
 * person reads when the provider does not answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolution = vi.hoisted(() => ({ delayMs: 0, read: (async () => ({})) as (ctx: { signal?: AbortSignal }) => Promise<unknown> }));

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
  usableIntegrations: async (input: { lifetime?: AbortSignal }) => {
    await new Promise((resolve) => setTimeout(resolve, resolution.delayMs));
    return [
      {
        manifest: { id: "acme", name: "Acme" },
        runtime: { api: { usage: (ctx: { signal?: AbortSignal }) => resolution.read(ctx) } },
        ctx: { signal: input.lifetime },
      },
    ];
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
});
