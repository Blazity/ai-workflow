/**
 * Integration connection state: where an integration's values come from, whether
 * they are complete, whether a human turned it off, and whether the last test
 * passed.
 *
 * `resolve.ts` is the only place a status is decided. Everything else here
 * composes it with the database, the registry and the provider.
 */
export {
  IntegrationVersionConflictError,
  disconnectIntegrationConnection,
  listIntegrations,
  readIntegrationStates,
  readIntegrationStatesOn,
  saveIntegrationConnection,
  secretsKeyMaterial,
  setIntegrationConnectionSource,
  setIntegrationEnabledState,
  testIntegrationConnection,
  type IntegrationActor,
  type SaveIntegrationConnectionInput,
} from "./authoring.js";

export {
  checkIntegrationPin,
  environmentReaderFrom,
  integrationConfigFingerprint,
  integrationVerificationFingerprint,
  resolveIntegrationState,
  type IntegrationEnvironmentReader,
  type IntegrationPinCheck,
  type IntegrationSecretsKeyState,
  type ResolveIntegrationInput,
  type StoredIntegrationConnection,
  type StoredIntegrationTest,
  type StoredIntegrationVersion,
} from "./resolve.js";

export {
  readConnectionValues,
  redactIntegrationText,
  secretValuesOf,
  type ConnectionValue,
  type ConnectionValuesResult,
  type IntegrationSecretsKeyMaterial,
} from "./connection-values.js";

export { buildIntegrationContext } from "./context.js";

export { failureReason } from "./failure-reason.js";

/** The automation account, saying whether it could be read at all. */
export async function readVcsBotLogin(
  kind: import("@shared/contracts").VcsProviderKind,
): Promise<
  { readable: true; login: string | undefined } | { readable: false; reason: string }
> {
  const resolver = await import("./vcs-bot-login.js");
  return resolver.readVcsBotLogin(kind);
}

// The secrets core redacts and scans for, and the one failure policy every
// caller shares: see secret-values.ts.
export { integrationSecretValues, knownSecretValues } from "./secret-values.js";

export {
  databaseEnvironment,
  decideIntegrationWriteAccess,
  deploymentEnvironment,
  integrationWriteAccess,
} from "./deployment-writes.js";

// `impact.ts` is deliberately not re-exported here. It is the one read in this
// folder that joins integrations with workflow definitions, and the definitions
// cluster already reads this barrel, so carrying it would close an import
// cycle the boundaries gate refuses. Its caller imports the module.
