import { describe, expect, it } from "vitest";
import { evaluateCondition, parseCondition } from "@shared/conditions";
import type { ConditionAst } from "@shared/conditions";
import {
  BLOCK_PARAM_KEYS,
  FAILURE_PORT,
  TRIGGER_BLOCK_TYPES,
  isTriggerBlockType,
  wirablePorts,
} from "@shared/contracts";
import type { BlockOutput, JsonValue } from "@shared/contracts";

function parseOk(src: string): { ast: ConditionAst; refs: string[] } {
  const result = parseCondition(src);
  if (!result.ok) throw new Error(`expected parse success for ${JSON.stringify(src)}: ${result.error}`);
  return { ast: result.ast, refs: result.refs };
}

function steps(map: Record<string, BlockOutput>): Record<string, { output: BlockOutput }> {
  const result: Record<string, { output: BlockOutput }> = {};
  for (const key of Object.keys(map)) result[key] = { output: map[key] };
  return result;
}

function evalSrc(src: string, state: Record<string, { output: BlockOutput }> = {}): boolean {
  return evaluateCondition(parseOk(src).ast, state);
}

describe("parseCondition grammar", () => {
  const cases: [string, ConditionAst][] = [
    ['"hi"', { kind: "lit", value: "hi" }],
    ["'hi'", { kind: "lit", value: "hi" }],
    ["42", { kind: "lit", value: 42 }],
    ["-3", { kind: "lit", value: -3 }],
    ["1.5", { kind: "lit", value: 1.5 }],
    ["true", { kind: "lit", value: true }],
    ["false", { kind: "lit", value: false }],
    ["null", { kind: "lit", value: null }],
    ["steps.a.output", { kind: "path", blockId: "a", segments: [] }],
    ["steps.a.output.x.y", { kind: "path", blockId: "a", segments: ["x", "y"] }],
    ["steps.my-block.output.ok", { kind: "path", blockId: "my-block", segments: ["ok"] }],
    ["!true", { kind: "not", operand: { kind: "lit", value: true } }],
    [
      'steps.a.output == "x"',
      { kind: "eq", left: { kind: "path", blockId: "a", segments: [] }, right: { kind: "lit", value: "x" } },
    ],
    [
      "steps.a.output != null",
      { kind: "neq", left: { kind: "path", blockId: "a", segments: [] }, right: { kind: "lit", value: null } },
    ],
    ["true && false", { kind: "and", left: { kind: "lit", value: true }, right: { kind: "lit", value: false } }],
    ["true || false", { kind: "or", left: { kind: "lit", value: true }, right: { kind: "lit", value: false } }],
    ["(true)", { kind: "lit", value: true }],
  ];

  it.each(cases)("parses %s", (src, expected) => {
    expect(parseOk(src).ast).toEqual(expected);
  });
});

describe("parseCondition refs", () => {
  it("collects referenced block ids in source order and dedupes", () => {
    expect(parseOk("steps.a.output.x == steps.b.output.y && steps.a.output.z").refs).toEqual(["a", "b"]);
  });

  it("returns no refs for literal-only expressions", () => {
    expect(parseOk("true && false").refs).toEqual([]);
  });
});

describe("parseCondition errors", () => {
  const errorCases: [string, string][] = [
    ["empty input", ""],
    ["bare '='", 'steps.a.output = 3'],
    ["unterminated string", '"hello'],
    ["path not rooted at steps", "foo.bar"],
    ["missing .output", "steps.a.status"],
    ["unbalanced parens", "(true"],
    ["trailing garbage", "steps.a.output steps.b.output"],
  ];

  it.each(errorCases)("rejects %s", (_label, src) => {
    const result = parseCondition(src);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it("reports a position in the message", () => {
    const result = parseCondition("steps.a.output = 3");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/position \d+/);
  });
});

describe("evaluateCondition semantics", () => {
  it("evaluates the spec status example", () => {
    const state = steps({ planning: { status: "needs_human_input" } });
    expect(evalSrc('steps.planning.output.status == "needs_human_input"', state)).toBe(true);
    expect(evalSrc('steps.planning.output.status == "done"', state)).toBe(false);
  });

  it("evaluates a bare boolean path", () => {
    expect(evalSrc("steps.checks.output.ok", steps({ checks: { status: "ok", ok: true } }))).toBe(true);
    expect(evalSrc("steps.checks.output.ok", steps({ checks: { status: "ok", ok: false } }))).toBe(false);
  });

  it("resolves missing hops to null", () => {
    const state = steps({ a: { status: "ok" } });
    expect(evalSrc("steps.a.output.missing == null", state)).toBe(true);
    expect(evalSrc("steps.missing.output.x == null", state)).toBe(true);
    expect(evalSrc("steps.a.output.missing", state)).toBe(false);
  });

  it("returns null when segmenting into a non-object", () => {
    const state = steps({ a: { status: "ok" } });
    expect(evalSrc("steps.a.output.status.foo == null", state)).toBe(true);
  });

  it("treats arrays as non-indexable", () => {
    const state = steps({ a: { status: "ok", list: [1, 2, 3] } });
    expect(evalSrc("steps.a.output.list.length == null", state)).toBe(true);
  });

  it("does not resolve inherited properties", () => {
    expect(evalSrc("steps.a.output.toString == null", steps({ a: { status: "ok" } }))).toBe(true);
  });

  it("walks nested objects", () => {
    const state = steps({ a: { status: "ok", data: { nested: { flag: true } } } });
    expect(evalSrc("steps.a.output.data.nested.flag", state)).toBe(true);
  });

  it("uses strict equality on primitives", () => {
    const state = steps({ a: { status: "ok", n: 1 } });
    expect(evalSrc('steps.a.output.n == "1"', state)).toBe(false);
    expect(evalSrc("steps.a.output.n == 1", state)).toBe(true);
  });

  it("never treats objects or arrays as equal", () => {
    const state = steps({ a: { status: "ok", obj: { x: 1 }, arr: [1, 2] } });
    expect(evalSrc("steps.a.output.obj == steps.a.output.obj", state)).toBe(false);
    expect(evalSrc("steps.a.output.arr == steps.a.output.arr", state)).toBe(false);
    expect(evalSrc("steps.a.output.obj != null", state)).toBe(true);
  });

  it("honours precedence and parentheses", () => {
    expect(evalSrc("!true && false")).toBe(false);
    expect(evalSrc("true || false && false")).toBe(true);
    expect(evalSrc("(true || false) && false")).toBe(false);
  });

  it("coerces only the exact boolean true as truthy", () => {
    expect(evalSrc("true")).toBe(true);
    expect(evalSrc("false")).toBe(false);
    const withValue = (value: JsonValue) => steps({ a: { status: "ok", v: value } });
    expect(evalSrc("steps.a.output.v", withValue(true))).toBe(true);
    expect(evalSrc("steps.a.output.v", withValue("true"))).toBe(false);
    expect(evalSrc("steps.a.output.v", withValue(1))).toBe(false);
    expect(evalSrc("steps.a.output.v", withValue({}))).toBe(false);
    expect(evalSrc("steps.a.output.v", withValue("nonempty"))).toBe(false);
  });
});

describe("contract helpers", () => {
  it("wirablePorts appends the failure port only when allowed", () => {
    expect(wirablePorts("planning_agent")).toEqual(["out", FAILURE_PORT]);
    expect(wirablePorts("trigger_ticket_ai")).toEqual(["out"]);
    expect(wirablePorts("branch")).toEqual(["true", "false"]);
    expect(wirablePorts("loop")).toEqual(["continue", "exhausted"]);
    expect(wirablePorts("terminate")).toEqual([]);
  });

  it("exposes only trigger blocks as trigger types", () => {
    expect(TRIGGER_BLOCK_TYPES).toEqual(["trigger_ticket_ai"]);
    expect(isTriggerBlockType("trigger_ticket_ai")).toBe(true);
    expect(isTriggerBlockType("branch")).toBe(false);
  });

  it("mirrors the editor param keys, including the control blocks", () => {
    expect(BLOCK_PARAM_KEYS.planning_agent).toEqual(["provider", "model"]);
    expect(BLOCK_PARAM_KEYS.run_pre_pr_checks).toEqual(["maxFixCycles"]);
    expect(BLOCK_PARAM_KEYS.branch).toEqual(["condition"]);
    expect(BLOCK_PARAM_KEYS.loop).toEqual(["maxAttempts", "onExhaust"]);
    expect(BLOCK_PARAM_KEYS.terminate).toEqual(["terminalStatus", "postComment"]);
  });
});
