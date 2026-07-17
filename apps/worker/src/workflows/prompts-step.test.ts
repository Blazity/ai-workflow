import { describe, it, expect } from "vitest";

import { loadPrompts } from "./prompts-step.js";
import { PROMPT_FALLBACKS } from "../lib/prompts.js";

describe("loadPrompts", () => {
  it("returns the in-code prompt templates", async () => {
    const result = await loadPrompts();
    expect(result.research).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(result.implement).toBe(PROMPT_FALLBACKS["implement"]);
    expect(result.review).toBe(PROMPT_FALLBACKS["review"]);
  });
});
