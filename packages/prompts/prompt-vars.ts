import { WORKFLOW_PROMPT_PARAM_KEYS } from "@shared/contracts";
import type { PromptVariableName } from "./prompt-variables";

/** Which string/string[] params of each block type carry authored prose. A run
 *  expands {{prompt:...}} references in exactly these fields, resolves their
 *  {{data:...}} tokens, and fails a non-agent block on any placeholder left in
 *  them. Deliberately excludes machine-shaped params (branch.condition,
 *  outputSchema, model, provider, commands, target, ...). */
export const VARIABLE_PARAM_KEYS = WORKFLOW_PROMPT_PARAM_KEYS;

/** Resolved {{name}} -> text map. Missing/unavailable known values are "" (never
 *  undefined) so a substituted placeholder never leaks the string "undefined". */
export type PromptVariableValues = Partial<Record<PromptVariableName, string>>;

/** {{name}}: lowercase-leading snake token, tolerant of inner whitespace. */
const VARIABLE_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Replace every known {{name}} in `text` with its value. Unknown names (not in
 *  `vars`) are left verbatim, including their braces, so a typo stays visible
 *  instead of vanishing. */
export function substitutePromptVariables(text: string, vars: PromptVariableValues): string {
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return vars[name as PromptVariableName] ?? "";
    }
    return match;
  });
}
