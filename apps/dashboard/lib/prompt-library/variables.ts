import { PROMPT_VARIABLES, type PromptVariableSpec } from "@shared/contracts";

/** The single dashboard-side view of the shared placeholder catalog. Keep this
 *  the only dashboard file importing PROMPT_VARIABLES so highlighting and
 *  autocomplete stay in sync from one source. */
export const AVAILABLE_VARIABLES: readonly PromptVariableSpec[] = PROMPT_VARIABLES;

const KNOWN_NAMES = new Set(AVAILABLE_VARIABLES.map((v) => v.name));

export type VarSegment =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string; known: boolean };

// A regex literal evaluated inside a function yields a fresh object each call,
// so lastIndex state is never shared between invocations.
const matcher = (): RegExp => /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Break a prompt body into alternating text and {{variable}} segments so the
 *  editor can render placeholders distinctly and flag unknown names. */
export function segmentTemplate(body: string): VarSegment[] {
  const segments: VarSegment[] = [];
  const re = matcher();
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ kind: "text", text: body.slice(lastIndex, m.index) });
    }
    const name = m[1];
    segments.push({ kind: "var", name, known: KNOWN_NAMES.has(name) });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < body.length) {
    segments.push({ kind: "text", text: body.slice(lastIndex) });
  }
  return segments;
}

/** Distinct variable names used in a body, in order of first appearance. */
export function usedVariables(body: string): { name: string; known: boolean }[] {
  const re = matcher();
  const seen = new Set<string>();
  const out: { name: string; known: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, known: KNOWN_NAMES.has(name) });
  }
  return out;
}
