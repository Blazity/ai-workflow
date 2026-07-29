import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// models.ts validates the worker env at module scope and the test process has no
// deployment env. Only FALLBACK_MODELS is read here and it is a plain const.
vi.mock("../../env.js", () => ({ env: {} }));

import { FALLBACK_MODELS } from "../workflow-definition/models.js";
import { computeUsageTotals, type PhaseUsage } from "../sandbox/usage.js";
import {
  REPO_MEMORY_DISTILL_CODEX_MODEL,
  optionalPricedModelsForRun,
  repoMemoryDistillTarget,
  resolveRunPriceLookup,
} from "./agent.js";

/** The full agent models a run would otherwise bill the distill against. */
const DEFAULTS = { claude: "claude-opus-4-6", codex: "gpt-5.4" };
const PRICE = { input: 0.000001, cached_input: 0, output: 0.000002 };
const DISTILL_PHASE = "Repo memory distill";
const distillUsage: PhaseUsage = {
  cost_usd: null,
  tokens: { input: 1000, cached_input: 0, output: 500 },
  duration_ms: 1200,
  duration_api_ms: 1200,
  num_turns: 1,
};

describe("repository memory distill model", () => {
  // A wrong id fails every distill on that path, and the step only logs, so
  // nothing downstream would surface it. Pin it to the catalog the deployment
  // already offers rather than to a literal nobody re-checks.
  it("is an id the deployment already offers", () => {
    expect(FALLBACK_MODELS.codex).toContain(REPO_MEMORY_DISTILL_CODEX_MODEL);
  });

  it("pins a cheap model on both provider paths, never the full agent model", () => {
    expect(repoMemoryDistillTarget("codex", DEFAULTS)).toEqual({
      provider: "codex",
      model: REPO_MEMORY_DISTILL_CODEX_MODEL,
    });
    // The claude path keeps call_llm's own cheap default. Asserted as "not the
    // agent model" so this does not restate call-llm.ts's constant.
    const claude = repoMemoryDistillTarget("claude", DEFAULTS);
    expect(claude.provider).toBe("claude");
    expect(claude.model).not.toBe(DEFAULTS.claude);
  });
});

describe("repository memory distill pricing", () => {
  // The distill's model is neither a definition node nor a harness runtime, so
  // nothing else puts it in the price map. Unpriced, its usage lands with an
  // unknown cost and one unknown phase marks the WHOLE run's cost unknown.
  it.each(["codex", "claude"] as const)(
    "records a known cost for the distill phase on the %s path",
    async (runDefaultKind) => {
      const distill = repoMemoryDistillTarget(runDefaultKind, DEFAULTS);
      const priceLookup = await resolveRunPriceLookup({
        requiredModels: new Set([DEFAULTS.codex]),
        optionalModels: optionalPricedModelsForRun({
          enableRepoMemory: true,
          runDefaultKind,
          defaults: DEFAULTS,
        }),
        maxCostUsd: 5,
        fetchPrice: async () => PRICE,
      });

      const totals = computeUsageTotals(
        { [DISTILL_PHASE]: distillUsage },
        priceLookup,
        undefined,
        { [DISTILL_PHASE]: distill.model },
      );

      expect(totals.costKnown).toBe(true);
      expect(totals.costUsd).toBeGreaterThan(0);
    },
  );

  // The distill is observed and never enforced: an exhausted budget skips it.
  // A missing LiteLLM entry for its model must therefore not fail the run it
  // rides along on.
  it("does not fail a run with maxCostUsd set when the distill price is missing", async () => {
    const distill = repoMemoryDistillTarget("codex", DEFAULTS);

    const priceLookup = await resolveRunPriceLookup({
      requiredModels: new Set([DEFAULTS.codex]),
      optionalModels: new Set([distill.model]),
      maxCostUsd: 5,
      fetchPrice: async (model) => (model === distill.model ? null : PRICE),
    });

    expect(priceLookup?.(distill.model)).toBeNull();
    expect(priceLookup?.(DEFAULTS.codex)).toEqual(PRICE);
  });

  // The other half of the same contract: widening the required set to the union
  // would make the case above throw, so prove the required set still bites.
  it("fails a run with maxCostUsd set when a required price is missing", async () => {
    await expect(
      resolveRunPriceLookup({
        requiredModels: new Set([DEFAULTS.codex]),
        optionalModels: new Set([REPO_MEMORY_DISTILL_CODEX_MODEL]),
        maxCostUsd: 5,
        fetchPrice: async (model) => (model === DEFAULTS.codex ? null : PRICE),
      }),
    ).rejects.toThrow(/pricing is unavailable for required model gpt-5\.4/);
  });

  it("prices the distill model only while ENABLE_REPO_MEMORY is on", async () => {
    expect(
      optionalPricedModelsForRun({
        enableRepoMemory: false,
        runDefaultKind: "codex",
        defaults: DEFAULTS,
      }).size,
    ).toBe(0);

    const fetchPrice = vi.fn(async () => PRICE);
    await resolveRunPriceLookup({
      requiredModels: new Set([DEFAULTS.codex]),
      optionalModels: optionalPricedModelsForRun({
        enableRepoMemory: false,
        runDefaultKind: "codex",
        defaults: DEFAULTS,
      }),
      maxCostUsd: undefined,
      fetchPrice,
    });

    expect(fetchPrice.mock.calls.flat()).toEqual([DEFAULTS.codex]);
  });

  // The claude-path run shape the optional set exists for: no codex runtime and
  // no call_llm node leaves pricedModels empty, so the distill is the only
  // priceable model. Also pins the cell where an empty required set must not
  // throw with maxCostUsd set.
  it("prices the distill when it is the only model to price", async () => {
    const lookup = await resolveRunPriceLookup({
      requiredModels: new Set(),
      optionalModels: new Set([REPO_MEMORY_DISTILL_CODEX_MODEL]),
      maxCostUsd: 5,
      fetchPrice: async () => PRICE,
    });

    expect(lookup?.(REPO_MEMORY_DISTILL_CODEX_MODEL)).toEqual(PRICE);
  });

  it("prices nothing and sets no lookup when there is nothing to price", async () => {
    const fetchPrice = vi.fn(async () => PRICE);

    await expect(
      resolveRunPriceLookup({
        requiredModels: new Set(),
        optionalModels: new Set(),
        maxCostUsd: 5,
        fetchPrice,
      }),
    ).resolves.toBeUndefined();
    expect(fetchPrice).not.toHaveBeenCalled();
  });
});

/**
 * Source tripwires, deliberately narrow.
 *
 * agentWorkflowBody is not exported and its memory call sites live inside the
 * executeBlock closure it builds around the interpreter, so no test can invoke
 * them. What follows therefore asserts ONLY that an ENABLE_REPO_MEMORY
 * reference still sits on the lines above each call site. It cannot tell a live
 * guard from a dead local, and it cannot see work hoisted above the guard. It
 * catches one thing: the gate being deleted outright, which would ship every
 * read, write and LLM call to installations that have the feature switched off.
 * Treat a failure as "go read the call site", not as a behavioral regression.
 */
const agentLines = readFileSync(
  fileURLToPath(new URL("./agent.ts", import.meta.url)),
  "utf8",
).split("\n");

const GUARD_WINDOW = 40;

describe("repository memory call sites in agent.ts", () => {
  it.each(["loadRepoMemorySourcesStep", "distillRepoMemoryStep"])(
    "still references ENABLE_REPO_MEMORY around the %s call",
    (step) => {
      // Anchored on the call, not on its argument list, so reflowing the
      // arguments or passing a variable does not fail this.
      const index = agentLines.findIndex((line) => line.includes(`${step}(`));
      expect(index, `${step} is no longer called in agent.ts`).toBeGreaterThan(-1);

      const window = agentLines.slice(Math.max(0, index - GUARD_WINDOW), index);
      expect(
        window.some((line) => line.includes("env.ENABLE_REPO_MEMORY")),
        `no ENABLE_REPO_MEMORY reference guards ${step}, so every installation with the flag off still runs it`,
      ).toBe(true);
    },
  );
});
