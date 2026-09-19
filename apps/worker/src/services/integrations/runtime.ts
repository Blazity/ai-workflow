/**
 * What running an integration block needs, and nothing else.
 *
 * The engine imports this module and no other part of `services` (the exception
 * is named in `scripts/gates/tiers.json`). It re-exports reads only: the state
 * of a connection, the values behind it, the key that opens the stored ones,
 * and the context an integration receives. The write surface of `index.ts`
 * (save, disconnect, set enabled, set source, test) is deliberately absent, so
 * a run can never change a connection while using it, and the exception that
 * lets the engine in cannot widen by accident.
 *
 * Every symbol here is defined elsewhere in this directory. Nothing is
 * re-derived: a second derivation of an integration's state is exactly what
 * `resolve.ts` exists to prevent.
 */
export { buildIntegrationContext } from "./context.js";

export {
  readConnectionValues,
  redactIntegrationText,
  secretValuesOf,
} from "./connection-values.js";

export { readIntegrationStates, secretsKeyMaterial } from "./authoring.js";

export { environmentReaderFrom } from "./resolve.js";
