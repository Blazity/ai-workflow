import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCtx } from "./support/types.js";

/**
 * What a person sees when a run reaches an integration block.
 *
 * The step decides; this is the translation into the run's own vocabulary, and
 * the part that says whether a failed run reads as "somebody changed a setting"
 * or as "a provider had a bad minute". The two send different people looking.
 */

const runStep = vi.hoisted(() => vi.fn());
const blockEntry = vi.hoisted(() => vi.fn());

vi.mock("../steps/integration-block-step.js", () => ({
  runIntegrationBlockStep: (...args: unknown[]) => runStep(...args),
}));
vi.mock("@integrations/registry", () => ({
  integrationBlock: (...args: unknown[]) => blockEntry(...args),
}));

const { executeIntegrationBlock, isIntegrationBlockType } = await import("./integration-block.js");

const node = {
  id: "announce",
  type: "acmenotify_announce",
  x: 0,
  y: 0,
  params: { channel: "releases" },
  inputs: {},
} as unknown as Parameters<typeof executeIntegrationBlock>[0];

const ctx = {
  runId: "run-1",
  integrationPins: [{ integrationId: "acmenotify", configFingerprint: "site-one" }],
  integrationLlmDefaults: { provider: "claude", model: "claude-test" },
} as unknown as EngineCtx;

beforeEach(() => {
  runStep.mockReset();
  blockEntry.mockReset();
  blockEntry.mockReturnValue({ integrationId: "acmenotify", block: { type: node.type } });
});

describe("a run reaching an integration block", () => {
  it("hands the step the pin the run started with", async () => {
    runStep.mockResolvedValue({ kind: "next", output: { status: "sent" } });

    await executeIntegrationBlock(node, {}, ctx, { message: "hello" }, { attempt: 2 } as never);

    expect(runStep).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "acmenotify",
        blockType: "acmenotify_announce",
        pin: { integrationId: "acmenotify", configFingerprint: "site-one" },
        configuration: { channel: "releases" },
        inputs: { message: "hello" },
        run: { runId: "run-1", nodeId: "announce", attempt: 2 },
      }),
    );
  });

  it("continues with the output the block produced", async () => {
    // One port, named `out`: the graph reads an integration block's ports from
    // core's catalog, which holds none of them, so a second port would be a
    // branch nothing could follow. A downstream branch tests `status`.
    runStep.mockResolvedValue({ kind: "next", output: { status: "sent", permalink: "u" } });

    const result = await executeIntegrationBlock(node, {}, ctx, {});

    expect(result).toEqual({ kind: "next", output: { status: "sent", permalink: "u" } });
  });

  it("fails the run as a configuration problem when the integration moved under it", async () => {
    runStep.mockResolvedValue({
      kind: "unavailable",
      reason: "reconfigured",
      message: "Acme Notify was reconfigured while this run was in flight, so the run stopped.",
    });

    const result = await executeIntegrationBlock(node, {}, ctx, {});

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") throw new Error("unreachable");
    // `configuration`, not `provider`: no retry and no provider can change this,
    // and the person who can is an admin editing a connection.
    expect(result.error.category).toBe("configuration");
    expect(result.error.message).toContain("Acme Notify was reconfigured");
    // `configuration` covers every setting an operator can get wrong, from a
    // repository the catalog does not enable upwards, so it cannot answer
    // "which of the three integration reasons was this?". The code can.
    expect(result.error.failureCode).toBe("integration_unavailable.reconfigured");
  });

  it("carries a failure code for each of the three reasons, not one for the family", async () => {
    for (const [reason, code] of [
      ["disconnected", "integration_unavailable.disconnected"],
      ["disabled", "integration_unavailable.disabled"],
      ["reconfigured", "integration_unavailable.reconfigured"],
    ] as const) {
      runStep.mockResolvedValue({ kind: "unavailable", reason, message: `stopped: ${reason}` });

      const result = await executeIntegrationBlock(node, {}, ctx, {});

      if (result.kind !== "execution_error") throw new Error("unreachable");
      expect(result.error.failureCode).toBe(code);
    }
  });

  it("leaves a block's own refusal without a code, because nothing generic caused it", async () => {
    // A provider saying no is not a case a machine can route on: the cause is
    // whatever that provider decided. Minting a code here would claim a
    // structure the failure does not have.
    runStep.mockResolvedValue({
      kind: "failed",
      message: "The channel no longer exists.",
      detail: "channel_not_found",
    });

    const result = await executeIntegrationBlock(node, {}, ctx, {});

    if (result.kind !== "execution_error") throw new Error("unreachable");
    expect(result.error.failureCode).toBeUndefined();
  });

  it("fails the run as a provider problem when the block itself refused", async () => {
    runStep.mockResolvedValue({
      kind: "failed",
      message: "The channel no longer exists.",
      detail: "channel_not_found",
    });

    const result = await executeIntegrationBlock(node, {}, ctx, {});

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") throw new Error("unreachable");
    expect(result.error.category).toBe("provider");
    expect(result.error.message).toContain("The channel no longer exists.");
  });

  it("refuses a node whose integration this build no longer ships, by the same route a run takes", async () => {
    // Reachable only because `isIntegrationBlockType` answers for every type
    // core does not own rather than only for the ones the registry ships: a
    // registry-backed guard sends exactly this node to the engine's
    // exhaustiveness default, which throws and names nothing.
    blockEntry.mockReturnValue(undefined);
    expect(isIntegrationBlockType(node.type)).toBe(true);

    const result = await executeIntegrationBlock(node, {}, ctx, {});

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") throw new Error("unreachable");
    expect(result.error.category).toBe("configuration");
    expect(result.error.message).toContain("acmenotify_announce");
    expect(runStep).not.toHaveBeenCalled();
  });

  it("leaves every core block type to core's own executor table", () => {
    expect(isIntegrationBlockType("post_ticket_comment")).toBe(false);
    expect(isIntegrationBlockType("planning_agent")).toBe(false);
  });
});
