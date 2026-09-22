/**
 * The environment half of "the secrets this deployment knows".
 *
 * The whole set is `knownSecretValues()` in services/integrations/secret-values.ts:
 * these values plus the secrets of every connected integration, including a
 * connection an admin stored in the dashboard, which is decrypted from the
 * database and never appears in the environment. Anything that can await
 * uses that set. This half exists for the code that cannot: workflow scope,
 * which sees the environment (the Workflow VM hands it a frozen copy) but can
 * never read a connection, and the few synchronous passes that run before a
 * value crosses into a step. What those passes miss, the step that writes or
 * publishes the value catches with the whole set.
 *
 * It is also the ONE rule for which environment variables hold a secret.
 * Three filters used to answer that question (this one, a second inside the
 * diagnostic redactor, a hand-kept list in the MCP sanitizer), and a variable
 * could be a secret to one of them and plain text to another.
 */

// The secret words, plus two kinds of names that hold a credential without
// saying so: a database connection string (DATABASE_URL, POSTGRES_URL and the
// variants the Neon integration injects carry the password) and an encryption
// key (WEBHOOK_TRIGGER_ENCRYPTION_KEY, which the MCP result sanitizer redacts).
const SECRET_ENVIRONMENT_KEY =
  /(?:password|secret|token|private[_-]?key|api[_-]?key|oauth|credential|encryption[_-]?key|(?:database|postgres)\w*url)/i;

export function environmentSecretValues(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        value.length > 0 &&
        SECRET_ENVIRONMENT_KEY.test(key),
    )
    .map(([, value]) => value!);
}
