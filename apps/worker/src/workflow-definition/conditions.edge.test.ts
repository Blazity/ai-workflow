import { describe, expect, it } from "vitest";
import { evaluateCondition, parseCondition } from "@shared/conditions";
import type { ConditionAst } from "@shared/conditions";
import type { BlockOutput } from "@shared/contracts";

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

describe("parseCondition grammar (edge cases)", () => {
  const cases: [string, ConditionAst][] = [
    // '!' binds looser than '=='/'!=': `!x == y` is not(eq), not (!x)==y.
    [
      '!steps.a.output.v == "x"',
      {
        kind: "not",
        operand: {
          kind: "eq",
          left: { kind: "path", blockId: "a", segments: ["v"] },
          right: { kind: "lit", value: "x" },
        },
      },
    ],
    ["((true))", { kind: "lit", value: true }],
    [
      "!(true || false)",
      {
        kind: "not",
        operand: { kind: "or", left: { kind: "lit", value: true }, right: { kind: "lit", value: false } },
      },
    ],
    ["!!true", { kind: "not", operand: { kind: "not", operand: { kind: "lit", value: true } } }],
    ['""', { kind: "lit", value: "" }],
    // No escape sequences: a backslash stays literal in the value.
    ['"a\\b"', { kind: "lit", value: "a\\b" }],
    // Operators/keywords inside a string are opaque to the lexer.
    [
      'steps.a.output.msg == "a && b"',
      {
        kind: "eq",
        left: { kind: "path", blockId: "a", segments: ["msg"] },
        right: { kind: "lit", value: "a && b" },
      },
    ],
    ["-1.5", { kind: "lit", value: -1.5 }],
    // Whitespace is skipped even around the dots inside a path.
    ["steps . a . output . x", { kind: "path", blockId: "a", segments: ["x"] }],
  ];

  it.each(cases)("parses %s", (src, expected) => {
    expect(parseOk(src).ast).toEqual(expected);
  });
});

describe("parseCondition refs (edge cases)", () => {
  it("collects refs in source order across !, || and parentheses, deduping", () => {
    expect(
      parseOk("!steps.b.output.x || (steps.a.output.y && steps.b.output.z)").refs,
    ).toEqual(["b", "a"]);
  });
});

describe("parseCondition errors (edge cases)", () => {
  const errorCases: [string, string, RegExp][] = [
    // Comparison right operand is a primary, not a unary: `x == !y` is a parse error.
    ["comparison right operand cannot be unary", 'steps.a.output == !steps.b.output', /position 18/],
    // Comparison is non-chainable / non-associative.
    ["comparison is not chainable", "true == true == true", /position 13/],
    ["empty parentheses", "()", /position 1/],
    ["stray closing paren", "true)", /position 4/],
    ["'!' with no operand", "!", /unexpected end of expression/],
    ["unterminated single-quote string", "'oops", /unterminated string literal at position 0/],
    // Trailing dot and leading dot numbers.
    ["trailing dot number", "3.", /position 1/],
    ["leading dot number", ".5", /position 0/],
    // Scientific notation is not part of the grammar.
    ["scientific notation", "1e5", /position 1/],
    // Arithmetic is unsupported.
    ["adjacent numbers from '3-3'", "3-3", /position 1/],
    ["subtraction operator", "steps.a.output.n - 3", /unexpected character "-"/],
    // Keywords are case-sensitive.
    ["uppercase TRUE is not a literal", "TRUE", /condition must reference steps\.<blockId>\.output/],
    ["bare identifier", "foo", /condition must reference steps\.<blockId>\.output/],
    // Relational operators do not exist.
    ["greater-than operator", "steps.a.output.n > 3", /unexpected character ">"/],
    // Single '|' / '&' are lexer errors.
    ["single pipe", "steps.a.output | 1", /unexpected character "\|"/],
    // Leading binary operators.
    ["leading &&", "&& true", /unexpected end of expression at position 0/],
    ["leading ==", "== 3", /unexpected end of expression at position 0/],
    // Path shape errors.
    ["bare steps", "steps", /expected '\.' after 'steps' at position 5/],
    ["steps with trailing dot", "steps.", /expected a block id after 'steps\.'/],
    ["steps.<id> without .output", "steps.a", /expected '\.output' after 'steps\.a'/],
    ["path with trailing dot", "steps.a.output.", /expected a property name after '\.'/],
    ["numeric path segment", "steps.a.output.items.0", /expected a property name after '\.'/],
  ];

  it.each(errorCases)("rejects %s", (_label, src, pattern) => {
    const result = parseCondition(src);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).toMatch(pattern);
    }
  });
});

describe("evaluateCondition semantics (edge cases)", () => {
  it("'!x == y' evaluates as not(eq): !('y' == 'x') is true", () => {
    expect(evalSrc('!steps.a.output.v == "x"', steps({ a: { status: "ok", v: "y" } }))).toBe(true);
  });

  it("binds comparison tighter than && and || in a mixed chain", () => {
    // Groups as (a.s=='x') || ((b.s=='y') && false).
    const state = steps({ a: { status: "ok", s: "x" }, b: { status: "ok", s: "n" } });
    expect(evalSrc('steps.a.output.s == "x" || steps.b.output.s == "y" && false', state)).toBe(true);
  });

  it("evaluates nested parentheses and negation", () => {
    expect(evalSrc("((true))")).toBe(true);
    expect(evalSrc("!(true || false)")).toBe(false);
    expect(evalSrc("!!true")).toBe(true);
  });

  it("compares against an empty string literal", () => {
    expect(evalSrc('steps.a.output.s == ""', steps({ a: { status: "ok", s: "" } }))).toBe(true);
  });

  it("treats quoted operators as opaque string content", () => {
    expect(evalSrc('steps.a.output.msg == "a && b"', steps({ a: { status: "ok", msg: "a && b" } }))).toBe(true);
  });

  it("skips whitespace around path dots", () => {
    expect(evalSrc("steps . a . output . x", steps({ a: { status: "ok", x: true } }))).toBe(true);
  });

  it("resolves a hyphenated property segment", () => {
    expect(evalSrc("steps.a.output.my-field == 1", steps({ a: { status: "ok", "my-field": 1 } }))).toBe(true);
  });

  it("uses strict equality across types and null", () => {
    expect(evalSrc("true == 1")).toBe(false);
    expect(evalSrc("null == null")).toBe(true);
  });

  it("applies '!=' between two differing strings", () => {
    const state = steps({ a: { status: "in_progress" } });
    expect(evalSrc('steps.a.output.status != "done"', state)).toBe(true);
    expect(evalSrc('steps.a.output.status != "in_progress"', state)).toBe(false);
  });

  it("reports an object as not equal to itself under '!='", () => {
    const state = steps({ a: { status: "ok", obj: { x: 1 } } });
    expect(evalSrc("steps.a.output.obj != steps.a.output.obj", state)).toBe(true);
  });

  it("treats the whole output object as an object for equality and truthiness", () => {
    const state = steps({ a: { status: "ok" } });
    expect(evalSrc("steps.a.output != null", state)).toBe(true);
    expect(evalSrc("steps.a.output == null", state)).toBe(false);
    expect(evalSrc("steps.a.output", state)).toBe(false);
  });

  it("distinguishes an explicit null field", () => {
    const state = steps({ a: { status: "ok", x: null } });
    expect(evalSrc("steps.a.output.x == null", state)).toBe(true);
    // Walking into a null value stops at null.
    expect(evalSrc("steps.a.output.x.y == null", state)).toBe(true);
  });

  it("blocks inherited prototype-pollution segments", () => {
    const state = steps({ a: { status: "ok" } });
    expect(evalSrc("steps.a.output.__proto__ == null", state)).toBe(true);
    expect(evalSrc("steps.a.output.constructor == null", state)).toBe(true);
  });

  it("coerces a bare non-boolean literal to false", () => {
    expect(evalSrc("42")).toBe(false);
    expect(evalSrc('"hi"')).toBe(false);
    expect(evalSrc("null")).toBe(false);
  });
});

describe("evaluateCondition boolean contract", () => {
  it("always returns a real boolean regardless of node kind", () => {
    expect(typeof evaluateCondition(parseOk('steps.a.output.status == "x"').ast, steps({ a: { status: "y" } }))).toBe(
      "boolean",
    );
    expect(typeof evaluateCondition(parseOk("steps.a.output.n").ast, steps({ a: { status: "ok", n: 5 } }))).toBe(
      "boolean",
    );
    expect(typeof evaluateCondition(parseOk("true && false").ast, {})).toBe("boolean");
  });
});
