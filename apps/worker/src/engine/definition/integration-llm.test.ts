/**
 * The one rule for which model an integration block's ctx.llm calls. The
 * editor asks it without knowing the run, so its "no" must not depend on the
 * run's preference, and its "yes" must never be a key a direct call refuses.
 */
import { describe, expect, it } from "vitest";
import { integrationLlmTarget } from "./integration-llm.js";

const models = { claude: "claude-run-model", codex: "gpt-run-model" };
const claude = { provider: "claude" as const, model: "claude-run-model" };
const codex = { provider: "codex" as const, model: "gpt-run-model" };

describe("the model an integration block calls", () => {
  it("is the run's preference when its provider takes a direct call", () => {
    expect(integrationLlmTarget(claude, models, { claude: true, codex: true })).toEqual(claude);
    expect(integrationLlmTarget(codex, models, { claude: true, codex: true })).toEqual(codex);
  });

  it("is the other provider, with the run's model for it, when the preferred one cannot take it", () => {
    expect(integrationLlmTarget(claude, models, { claude: false, codex: true })).toEqual(codex);
    expect(integrationLlmTarget(codex, models, { claude: true, codex: false })).toEqual(claude);
  });

  it("is none exactly when no provider takes a direct call, whatever the preference", () => {
    for (const preferred of [claude, codex]) {
      expect(integrationLlmTarget(preferred, models, { claude: false, codex: false })).toBeNull();
      expect(integrationLlmTarget(preferred, models, { claude: true, codex: false })).not.toBeNull();
      expect(integrationLlmTarget(preferred, models, { claude: false, codex: true })).not.toBeNull();
    }
  });
});
