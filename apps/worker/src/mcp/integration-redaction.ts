/**
 * The variable names an integration declares, and why this surface hides them.
 *
 * `agentFacingIntegrations` renders the sentences MCP composes itself, so a
 * palette entry, a draft issue and `system.capabilities` never name a variable.
 * Three things still carry text this surface did not compose: a failed run's
 * durable reason, a dispatch blocker, and a publish refusal built from the
 * editor's issues. All three are written by code that answers an ADMIN, and an
 * admin is entitled to read "Set DEMO_API_TOKEN on this deployment".
 *
 * A model is not, and the difference is not cosmetic: a model holding the exact
 * variable name is one sentence away from asking a person to paste a token into
 * a chat, which is the outcome ADR-010 decision 15 exists to prevent. So the
 * names go, as exact strings taken from the manifests rather than as a pattern
 * guessed off the prose, and what is left still names the integration and the
 * page a person fixes it on.
 *
 * This is the floor, not the mechanism: a sentence that reaches a model should
 * have been composed for one. The floor is what keeps the property true for
 * text written by code that never heard of this surface.
 */
import { integrationManifests } from "@integrations/registry";

/**
 * What replaces a name. Not `[REDACTED]`, which reads as "something was taken
 * from you": the sentence stays readable, and an agent relaying it to a person
 * says the true thing, that a deployment variable is involved and an admin has
 * to look.
 */
export const INTEGRATION_VARIABLE_PLACEHOLDER = "[a deployment variable]";

/**
 * Short enough to appear inside ordinary words, so redacting it would shred
 * every response that happened to contain those letters. Conformance only
 * requires `^[A-Z][A-Z0-9_]*$`, so a one-letter name is legal and would do
 * exactly that. Four is below every real name and above every dangerous one.
 *
 * An exemption in a comment is an exemption nobody applies, so the same number
 * is a rule over every shipped manifest in
 * `integrations/registry/reserved-env.test.ts`: a variable short enough to fall
 * through this floor cannot ship in the first place. Change one and change the
 * other.
 */
const MIN_REDACTED_NAME_LENGTH = 4;

/**
 * The core variable that holds every stored integration secret. Named by the
 * `secrets_key_missing` sentence S2 composes, and it belongs to the same
 * boundary: it is the one variable whose value would unlock all the others.
 */
const INTEGRATION_SECRETS_KEY = "INTEGRATION_SECRETS_KEY";

/**
 * Every declared variable name in this build, longest first.
 *
 * Longest first matters: `DEMO_API_TOKEN_ID` and `DEMO_API_TOKEN` can both be
 * declared, and replacing the shorter one first would leave `[a deployment
 * variable]_ID` behind, which still tells a reader what the name was.
 */
const INTEGRATION_VARIABLE_NAMES: readonly string[] = [
  ...new Set([
    INTEGRATION_SECRETS_KEY,
    ...integrationManifests.flatMap((manifest) =>
      manifest.connection.fields.map((field) => field.env),
    ),
  ]),
]
  .filter((name) => name.length >= MIN_REDACTED_NAME_LENGTH)
  .sort((a, b) => b.length - a.length);

/**
 * The same names as case-folding patterns.
 *
 * Case-exact matching would let a lowercase echo of a name through, and an
 * agent asking a person to "set demo_api_token" has learned exactly what this
 * module exists to withhold. Provider tooling, log lines and shell transcripts
 * all spell a variable whichever way they feel like.
 */
export const INTEGRATION_VARIABLE_PATTERNS: readonly RegExp[] = INTEGRATION_VARIABLE_NAMES.map(
  (name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), "giu"),
);

/**
 * The same floor for text that leaves as an error message rather than inside an
 * envelope. `workflows.publish` refuses with the issues the deployment gate
 * raised, and that gate resolves contracts for an admin, not for an agent.
 */
export function redactIntegrationVariableNames(text: string): string {
  let value = text;
  for (const pattern of INTEGRATION_VARIABLE_PATTERNS) {
    value = value.replace(pattern, INTEGRATION_VARIABLE_PLACEHOLDER);
  }
  return value;
}
