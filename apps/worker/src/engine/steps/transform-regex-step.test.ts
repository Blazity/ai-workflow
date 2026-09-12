import { describe, expect, it } from "vitest";
import type { V2BindingResolutionContext } from "@shared/workflow-graph";
import { executeTransform } from "../../workflow-definition/transform.js";
import { transformRegexEvaluator } from "../helpers/transform-regex-evaluator.js";
import { replaceTextRegexStep } from "./transform-regex-step.js";

/**
 * Every regex replacement fixture the repository asserts on
 * (`workflow-definition/transform.test.ts`), run through the injected
 * evaluator instead of the import `transform.ts` used to reach for.
 *
 * The inversion is only safe if the output is the same string, byte for byte,
 * so each fixture is checked twice: against the expectation the suite has
 * always held, and against what the step itself returns for the same call.
 */
const REGEX_FIXTURES = [
  {
    name: "collapses every whitespace run",
    source: "  Hello world  ",
    pattern: "\\s+",
    replacement: "-",
    ignoreCase: false,
    expected: "-Hello-world-",
  },
  {
    name: "matches case-insensitively and replaces with literal text",
    source: "  Hello world  ",
    pattern: "WORLD",
    replacement: "$1",
    ignoreCase: true,
    expected: "  Hello $1  ",
  },
] as const;

function contextFor(text: string): V2BindingResolutionContext {
  return {
    entryOutput: { status: "ok", text },
    runValues: {},
    getStepOutput: () => undefined,
  };
}

describe("transform regex evaluator", () => {
  it.each(REGEX_FIXTURES)(
    "$name",
    async ({ source, pattern, replacement, ignoreCase, expected }) => {
      const throughTransform = await executeTransform(
        {
          operation: "replace_text",
          source: "steps.entry.output.text",
          mode: "regex",
          pattern,
          replacement,
          ignoreCase,
        },
        contextFor(source),
        transformRegexEvaluator,
      );
      expect(throughTransform).toBe(expected);
      expect(throughTransform).toBe(
        await replaceTextRegexStep(source, pattern, replacement, ignoreCase),
      );
    },
  );

  it("refuses a regex transform when no evaluator is injected", async () => {
    await expect(
      (async () =>
        executeTransform(
          {
            operation: "replace_text",
            source: "steps.entry.output.text",
            mode: "regex",
            pattern: "\\s+",
            replacement: "-",
            ignoreCase: false,
          },
          contextFor("  Hello world  "),
        ))(),
    ).rejects.toThrow("Replace text in regex mode requires a regex evaluator.");
  });

  it("leaves plain replacement working without an evaluator", async () => {
    expect(
      await executeTransform(
        {
          operation: "replace_text",
          source: "steps.entry.output.text",
          mode: "plain",
          pattern: "world",
          replacement: "you",
          ignoreCase: false,
        },
        contextFor("  Hello world  "),
      ),
    ).toBe("  Hello you  ");
  });
});
