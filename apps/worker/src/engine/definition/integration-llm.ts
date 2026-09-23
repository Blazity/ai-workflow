/**
 * Which model an integration block's `ctx.llm` calls, and whether it can call
 * one at all. THE ONE RULE: the editor's gate and the block step both ask it,
 * so a block the palette offers is a block whose first model call has a key.
 *
 * The run prefers its own default (the provider and model of the first agent
 * the run resolved, `resolveRunHarnessDefaults`). That preference is only
 * knowable inside a run: it depends on the Harness Profiles the definition
 * pins (custom ones live in the database) and on a ticket's `agent:<kind>`
 * label. So the preference decides WHICH provider, never WHETHER: when the
 * preferred provider has no key a direct call accepts (a Claude OAuth token is
 * an agent's credential, not an API key), the other provider serves, with the
 * run's model for it. The answer is null exactly when neither provider has a
 * direct-call key, whatever the preference, which is what lets the gate ask
 * without knowing the run.
 */
export type IntegrationLlmProvider = "claude" | "codex";

export interface IntegrationLlmTarget {
  readonly provider: IntegrationLlmProvider;
  readonly model: string;
}

export function integrationLlmTarget(
  preferred: IntegrationLlmTarget,
  models: Readonly<Record<IntegrationLlmProvider, string>>,
  directCallCredentials: Readonly<Record<IntegrationLlmProvider, boolean>>,
): IntegrationLlmTarget | null {
  if (directCallCredentials[preferred.provider]) return preferred;
  const other: IntegrationLlmProvider = preferred.provider === "claude" ? "codex" : "claude";
  return directCallCredentials[other] ? { provider: other, model: models[other] } : null;
}

/** What a person reads when no provider has a key a direct model call accepts. */
export function integrationLlmUnavailable(label: string): string {
  return `${label} calls a model directly, and neither a Claude nor a Codex API key is configured (a Claude OAuth token serves agents only).`;
}
