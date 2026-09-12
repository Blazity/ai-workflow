import type { TransformRegexEvaluator } from "@shared/workflow-graph";

/**
 * The regex engine a Transform block borrows, bound to the one step that owns
 * RE2.
 *
 * `@shared/workflow-graph` states the transform semantics and takes this
 * evaluator as a parameter, so nothing about a transform reaches into the
 * engine any more.
 * The step module is still reached through a dynamic import, for two reasons
 * that outlive the inversion: `transform-regex-step.ts` loads `re2-wasm` and
 * its `.wasm` asset, and a static edge would also pull that step module into
 * the reachable graph of every webhook route (`routes/import-graph-guard.test.ts`).
 *
 * The step keeps the argument list it has always had. A step's identity is its
 * module path plus its function name, and its journaled call has to replay
 * identically across a deployment, so the RE2 flag string the transform builds
 * is read back here rather than travelling as a new argument.
 */
export const transformRegexEvaluator: TransformRegexEvaluator = {
  evaluate: async ({ pattern, flags, input, replacement }) => {
    const { replaceTextRegexStep } = await import(
      "../steps/transform-regex-step.js"
    );
    return replaceTextRegexStep(input, pattern, replacement, flags.includes("i"));
  },
};
