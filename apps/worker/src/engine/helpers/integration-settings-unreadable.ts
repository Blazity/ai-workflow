/**
 * How engine code recognises "this deployment's integration settings could not
 * be read" after the error crossed a step boundary.
 *
 * The error is `IntegrationSettingsUnreadableError` in
 * `services/integrations/usable.ts`. A step's thrown error reaches the
 * workflow body rebuilt from its name and message, not as that class, and the
 * workflow body may not import the services module anyway (it reaches a Node
 * module), so it is recognised by name, the way `isChecksCeilingExceededError`
 * is. A LEAF: nothing is imported here.
 */
export const INTEGRATION_SETTINGS_UNREADABLE_ERROR_NAME = "IntegrationSettingsUnreadableError";

export function isIntegrationSettingsUnreadableError(
  error: unknown,
): error is Error & { name: typeof INTEGRATION_SETTINGS_UNREADABLE_ERROR_NAME } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === INTEGRATION_SETTINGS_UNREADABLE_ERROR_NAME &&
    "message" in error &&
    typeof error.message === "string"
  );
}
