/**
 * Run control: the commands somebody outside the product can give a run, and
 * what core answers.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file.
 */
export {
  executeRunControlCommand,
  runControlDeps,
  type CancelRunFn,
  type RunControlDeps,
} from "./execute.js";
