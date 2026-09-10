import {
  WORKFLOW_PROMPT_PARAM_KEYS,
  type WorkflowDefinitionNode,
  type WorkflowParamValue,
} from "@shared/contracts";
import type { PromptVariableName } from "./prompt-variables";

/** Which string/string[] params of each block type receive {{var}} substitution.
 *  Deliberately excludes machine-shaped params (branch.condition, outputSchema,
 *  model, provider, commands, target, ...). */
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

/** Substitute variables into the node's prompt-bearing params (see
 *  VARIABLE_PARAM_KEYS). Returns the SAME node object when nothing changed (block
 *  type not listed, no tokens, or no known names matched); otherwise a shallow
 *  clone with a fresh params object. Never mutates the input node. */
export function substituteNodePromptParams(
  node: WorkflowDefinitionNode,
  vars: PromptVariableValues,
): WorkflowDefinitionNode {
  const keys = VARIABLE_PARAM_KEYS[node.type];
  if (!keys) return node;

  let changed = false;
  const nextParams: Record<string, WorkflowParamValue> = { ...node.params };

  for (const key of keys) {
    const value = node.params[key];
    if (typeof value === "string") {
      const substituted = substitutePromptVariables(value, vars);
      if (substituted !== value) {
        nextParams[key] = substituted;
        changed = true;
      }
    } else if (Array.isArray(value)) {
      let arrChanged = false;
      const nextArr = value.map((item) => {
        const substituted = substitutePromptVariables(item, vars);
        if (substituted !== item) arrChanged = true;
        return substituted;
      });
      if (arrChanged) {
        nextParams[key] = nextArr;
        changed = true;
      }
    }
  }

  if (!changed) return node;
  return { ...node, params: nextParams };
}
