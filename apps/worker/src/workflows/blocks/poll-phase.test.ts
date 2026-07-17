import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  checkPhaseDone: vi.fn(),
  sandboxGet: vi.fn(),
  getCommand: vi.fn(),
  kill: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("../../sandbox/poll-agent.js", () => ({ checkPhaseDone: mocks.checkPhaseDone }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));

import { pollPhaseUntilDone } from "./poll-phase.js";

const ok = (remainingDurationMs: number) => ({
  check: { status: "ok" as const },
  remainingDurationMs,
});

const durationFailure = {
  status: "budget_exceeded" as const,
  metric: "duration" as const,
  limit: 10_000,
  consumed: 10_001,
  reason: "budget_exceeded: duration 10001 exceeds limit 10000",
};

describe("pollPhaseUntilDone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCommand.mockResolvedValue({ kill: mocks.kill });
    mocks.sandboxGet.mockResolvedValue({ getCommand: mocks.getCommand });
  });

  it("caps each Workflow sleep to the remaining active duration", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(12_345))
      .mockResolvedValueOnce(ok(10_000));
    mocks.checkPhaseDone.mockResolvedValue(true);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-1", observeBudget),
    ).resolves.toBe(true);

    expect(mocks.sleep).toHaveBeenCalledWith("12345ms");
    expect(mocks.checkPhaseDone).toHaveBeenCalledWith("sbx-1", "/tmp/done");
    expect(observeBudget.mock.calls).toEqual([[true], [false]]);
  });

  it("accepts a phase that writes its sentinel exactly at the duration limit", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(5_000))
      .mockResolvedValueOnce({
        check: { status: "ok" },
        remainingDurationMs: 0,
        durationLimitMs: 5_000,
        activeElapsedMs: 5_000,
      });
    mocks.checkPhaseDone.mockResolvedValue(true);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-exact", observeBudget),
    ).resolves.toBe(true);

    expect(observeBudget.mock.calls).toEqual([[true], [false]]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("kills a phase that remains active exactly at the duration limit", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(5_000))
      .mockResolvedValueOnce({
        check: { status: "ok" },
        remainingDurationMs: 0,
        durationLimitMs: 5_000,
        activeElapsedMs: 5_000,
      });
    mocks.checkPhaseDone.mockResolvedValue(false);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-exact-active", observeBudget),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: {
        status: "budget_exceeded",
        metric: "duration",
        limit: 5_000,
        consumed: 5_000,
      },
    });

    expect(mocks.kill).toHaveBeenCalledOnce();
  });

  it("kills the detached command and throws the deterministic budget failure on expiry", async () => {
    const observeBudget = vi
      .fn()
      .mockResolvedValueOnce(ok(5_000))
      .mockResolvedValueOnce({ check: durationFailure, remainingDurationMs: 0 });

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-9", observeBudget),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: durationFailure,
    });

    expect(mocks.sleep).toHaveBeenCalledWith("5000ms");
    expect(mocks.sandboxGet).toHaveBeenCalledWith({ sandboxId: "sbx-1" });
    expect(mocks.getCommand).toHaveBeenCalledWith("cmd-9");
    expect(mocks.kill).toHaveBeenCalledOnce();
    expect(mocks.checkPhaseDone).toHaveBeenCalledWith("sbx-1", "/tmp/done");
  });

  it("kills the detached command when no active duration remains before sleeping", async () => {
    const observeBudget = vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 0,
      durationLimitMs: 100,
      activeElapsedMs: 100,
    });

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 25, "cmd-0", observeBudget),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: {
        status: "budget_exceeded",
        metric: "duration",
        limit: 100,
        consumed: 100,
      },
    });

    expect(mocks.getCommand).toHaveBeenCalledWith("cmd-0");
    expect(mocks.kill).toHaveBeenCalledOnce();
    expect(mocks.sleep).not.toHaveBeenCalled();
    expect(mocks.checkPhaseDone).not.toHaveBeenCalled();
  });

  it("kills the exact detached command before returning false at the normal phase cap", async () => {
    const observeBudget = vi.fn().mockResolvedValue(ok(60_000));
    mocks.checkPhaseDone.mockResolvedValue(false);

    await expect(
      pollPhaseUntilDone("sbx-1", "/tmp/done", 0.0001, "cmd-normal-cap", observeBudget),
    ).resolves.toBe(false);

    expect(mocks.getCommand).toHaveBeenCalledWith("cmd-normal-cap");
    expect(mocks.kill).toHaveBeenCalledOnce();
  });
});
