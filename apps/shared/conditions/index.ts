import type { BlockOutput, JsonValue } from "@shared/contracts";

export type ConditionAst =
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "path"; blockId: string; segments: string[] }
  | { kind: "not"; operand: ConditionAst }
  | { kind: "and"; left: ConditionAst; right: ConditionAst }
  | { kind: "or"; left: ConditionAst; right: ConditionAst }
  | { kind: "eq"; left: ConditionAst; right: ConditionAst }
  | { kind: "neq"; left: ConditionAst; right: ConditionAst };

type ParseResult =
  | { ok: true; ast: ConditionAst; refs: string[] }
  | { ok: false; error: string };

type Token =
  | { t: "and"; pos: number }
  | { t: "or"; pos: number }
  | { t: "eq"; pos: number }
  | { t: "neq"; pos: number }
  | { t: "not"; pos: number }
  | { t: "lparen"; pos: number }
  | { t: "rparen"; pos: number }
  | { t: "dot"; pos: number }
  | { t: "string"; value: string; pos: number }
  | { t: "number"; value: number; pos: number }
  | { t: "ident"; value: string; pos: number }
  | { t: "eof"; pos: number };

class ConditionError extends Error {}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch) || ch === "-";
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const length = src.length;
  let i = 0;
  while (i < length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    const pos = i;
    if (ch === "|" && src[i + 1] === "|") {
      tokens.push({ t: "or", pos });
      i += 2;
      continue;
    }
    if (ch === "&" && src[i + 1] === "&") {
      tokens.push({ t: "and", pos });
      i += 2;
      continue;
    }
    if (ch === "=" && src[i + 1] === "=") {
      tokens.push({ t: "eq", pos });
      i += 2;
      continue;
    }
    if (ch === "!" && src[i + 1] === "=") {
      tokens.push({ t: "neq", pos });
      i += 2;
      continue;
    }
    if (ch === "!") {
      tokens.push({ t: "not", pos });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "lparen", pos });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rparen", pos });
      i += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ t: "dot", pos });
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let value = "";
      while (j < length && src[j] !== quote) {
        value += src[j];
        j += 1;
      }
      if (j >= length) {
        throw new ConditionError(`unterminated string literal at position ${pos}`);
      }
      tokens.push({ t: "string", value, pos });
      i = j + 1;
      continue;
    }
    if (isDigit(ch) || (ch === "-" && isDigit(src[i + 1]))) {
      let j = ch === "-" ? i + 1 : i;
      while (j < length && isDigit(src[j])) j += 1;
      if (src[j] === "." && isDigit(src[j + 1])) {
        j += 1;
        while (j < length && isDigit(src[j])) j += 1;
      }
      tokens.push({ t: "number", value: Number(src.slice(i, j)), pos });
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < length && isIdentPart(src[j])) j += 1;
      tokens.push({ t: "ident", value: src.slice(i, j), pos });
      i = j;
      continue;
    }
    throw new ConditionError(`unexpected character ${JSON.stringify(ch)} at position ${pos}`);
  }
  tokens.push({ t: "eof", pos: length });
  return tokens;
}

function parseTokens(tokens: Token[]): { ast: ConditionAst; refs: string[] } {
  let index = 0;
  const refs: string[] = [];
  const seen = new Set<string>();

  const peek = (): Token => tokens[index];
  const advance = (): Token => tokens[index++];

  function parseExpr(): ConditionAst {
    return parseOr();
  }

  function parseOr(): ConditionAst {
    let node = parseAnd();
    while (peek().t === "or") {
      advance();
      node = { kind: "or", left: node, right: parseAnd() };
    }
    return node;
  }

  function parseAnd(): ConditionAst {
    let node = parseUnary();
    while (peek().t === "and") {
      advance();
      node = { kind: "and", left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary(): ConditionAst {
    if (peek().t === "not") {
      advance();
      return { kind: "not", operand: parseUnary() };
    }
    return parseComparison();
  }

  function parseComparison(): ConditionAst {
    const left = parsePrimary();
    const op = peek().t;
    if (op === "eq") {
      advance();
      return { kind: "eq", left, right: parsePrimary() };
    }
    if (op === "neq") {
      advance();
      return { kind: "neq", left, right: parsePrimary() };
    }
    return left;
  }

  function parsePrimary(): ConditionAst {
    const token = peek();
    if (token.t === "lparen") {
      advance();
      const inner = parseExpr();
      if (peek().t !== "rparen") {
        throw new ConditionError(`expected ')' at position ${peek().pos}`);
      }
      advance();
      return inner;
    }
    if (token.t === "string") {
      advance();
      return { kind: "lit", value: token.value };
    }
    if (token.t === "number") {
      advance();
      return { kind: "lit", value: token.value };
    }
    if (token.t === "ident") {
      if (token.value === "true") {
        advance();
        return { kind: "lit", value: true };
      }
      if (token.value === "false") {
        advance();
        return { kind: "lit", value: false };
      }
      if (token.value === "null") {
        advance();
        return { kind: "lit", value: null };
      }
      if (token.value === "steps") {
        return parsePath();
      }
      throw new ConditionError(
        `condition must reference steps.<blockId>.output... at position ${token.pos}`,
      );
    }
    throw new ConditionError(`unexpected end of expression at position ${token.pos}`);
  }

  function parsePath(): ConditionAst {
    advance();
    if (peek().t !== "dot") {
      throw new ConditionError(`expected '.' after 'steps' at position ${peek().pos}`);
    }
    advance();
    const idToken = peek();
    if (idToken.t !== "ident") {
      throw new ConditionError(`expected a block id after 'steps.' at position ${idToken.pos}`);
    }
    advance();
    const blockId = idToken.value;
    if (peek().t !== "dot") {
      throw new ConditionError(
        `expected '.output' after 'steps.${blockId}' at position ${peek().pos}`,
      );
    }
    advance();
    const outputToken = peek();
    if (outputToken.t !== "ident" || outputToken.value !== "output") {
      throw new ConditionError(
        `expected '.output' after 'steps.${blockId}' at position ${outputToken.pos}`,
      );
    }
    advance();
    const segments: string[] = [];
    while (peek().t === "dot") {
      advance();
      const segToken = peek();
      if (segToken.t !== "ident") {
        throw new ConditionError(`expected a property name after '.' at position ${segToken.pos}`);
      }
      advance();
      segments.push(segToken.value);
    }
    if (!seen.has(blockId)) {
      seen.add(blockId);
      refs.push(blockId);
    }
    return { kind: "path", blockId, segments };
  }

  const ast = parseExpr();
  if (peek().t !== "eof") {
    throw new ConditionError(
      `expected '==', '!=', '&&', '||' or end of expression at position ${peek().pos}`,
    );
  }
  return { ast, refs };
}

/** Parse a condition source string into an AST plus its ordered, de-duplicated block refs. */
export function parseCondition(src: string): ParseResult {
  try {
    const tokens = tokenize(src);
    const { ast, refs } = parseTokens(tokens);
    return { ok: true, ast, refs };
  } catch (error) {
    if (error instanceof ConditionError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

function isArrayOrObject(value: JsonValue): boolean {
  return value !== null && typeof value === "object";
}

function truthy(value: JsonValue): boolean {
  return value === true;
}

function strictEquals(left: JsonValue, right: JsonValue): boolean {
  if (isArrayOrObject(left) || isArrayOrObject(right)) return false;
  return left === right;
}

function resolvePath(
  node: { blockId: string; segments: string[] },
  steps: Record<string, { output: BlockOutput }>,
): JsonValue {
  const step = steps[node.blockId];
  if (!step) {
    // A genuinely missing step means the referenced block never ran on this
    // path. The graph validator requires referenced blocks to dominate the
    // branch, so this should be impossible; erroring (instead of coercing to
    // null) surfaces the bug rather than silently evaluating against null.
    throw new ConditionError(
      `condition references block "${node.blockId}" which has not produced an output`,
    );
  }
  let current: JsonValue = step.output;
  for (const segment of node.segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return null;
    current = current[segment];
  }
  return current;
}

function evalNode(node: ConditionAst, steps: Record<string, { output: BlockOutput }>): JsonValue {
  switch (node.kind) {
    case "lit":
      return node.value;
    case "path":
      return resolvePath(node, steps);
    case "not":
      return !truthy(evalNode(node.operand, steps));
    case "and":
      return truthy(evalNode(node.left, steps)) && truthy(evalNode(node.right, steps));
    case "or":
      return truthy(evalNode(node.left, steps)) || truthy(evalNode(node.right, steps));
    case "eq":
      return strictEquals(evalNode(node.left, steps), evalNode(node.right, steps));
    case "neq":
      return !strictEquals(evalNode(node.left, steps), evalNode(node.right, steps));
  }
}

/** Evaluate a parsed condition against block outputs, coercing the result to a boolean. */
export function evaluateCondition(
  ast: ConditionAst,
  steps: Record<string, { output: BlockOutput }>,
): boolean {
  return truthy(evalNode(ast, steps));
}
