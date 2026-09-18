import { describe, expect, it, vi } from "vitest";
import type { RepositoryKey } from "@shared/contracts";
import { readRepositoryAnswerWithModel } from "./read-answer.js";

const generateProviderText = vi.fn();

vi.mock("../../infra/llm.js", () => ({
  generateProviderText: (input: unknown) => generateProviderText(input),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: { ANTHROPIC_API_KEY: "test-anthropic-key", CODEX_API_KEY: undefined },
}));

const API = "github:acme/api" as RepositoryKey;

describe("the provider call behind a reading", () => {
  it("asks for temperature 0, so the same words are read the same way twice", async () => {
    // Production, 18.09: at the provider's default temperature "you decide"
    // came back delegated in one run and unclear in the next. A reading
    // records a decision in somebody's name; it may not depend on a coin toss.
    generateProviderText.mockResolvedValueOnce({
      object: { outcome: "delegated" },
      text: "",
      usage: null,
    });
    const reading = await readRepositoryAnswerWithModel("you decide", {
      questions: [`Should this ticket also use ${API}? Reply "yes" or "no".`],
      askedKeys: [API],
      shape: "one",
      heldKeys: [],
    });
    expect(reading.readBy).toBe("model");
    expect(generateProviderText).toHaveBeenCalledTimes(1);
    expect(generateProviderText.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });
});
