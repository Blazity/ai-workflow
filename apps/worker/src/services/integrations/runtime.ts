/**
 * What running an integration block needs, and nothing else.
 *
 * The engine imports this module and no other part of `services` (the exception
 * is named in `scripts/gates/tiers.json`). It re-exports reads only: the state
 * of each connection, the usable integrations with the context and redaction
 * each one is handed (built once, in `usable.ts`), the pin check, and the
 * secrets core scans for. The write surface of `index.ts`
 * (save, disconnect, set enabled, set source, test) is deliberately absent, so
 * a run can never change a connection while using it, and the exception that
 * lets the engine in cannot widen by accident.
 *
 * Every symbol here is defined elsewhere in this directory. Nothing is
 * re-derived: a second derivation of an integration's state is exactly what
 * `resolve.ts` exists to prevent.
 */
export { readIntegrationStates } from "./authoring.js";

// Pure, and a read in the sense this facade means: it compares what a run
// recorded against what the deployment says now and answers whether the run
// may still use it. No connection is touched, and nothing is written.
export { checkIntegrationPin } from "./resolve.js";

export { IntegrationSettingsUnreadableError, resolveUsableIntegrations } from "./usable.js";
export type { IntegrationRedaction } from "./usable.js";

// The secrets core redacts and scans for. One source: see secret-values.ts for
// the rule and for the failure policy every caller shares.
export {
  IntegrationSecretsUnreadableError,
  integrationSecretValues,
  knownSecretValues,
} from "./secret-values.js";
