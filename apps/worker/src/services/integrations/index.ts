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
  saveIntegrationConnection,
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

export {
  databaseEnvironment,
  decideIntegrationWriteAccess,
  deploymentEnvironment,
  integrationWriteAccess,
} from "./deployment-writes.js";
