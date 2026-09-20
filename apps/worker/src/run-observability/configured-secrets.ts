// The secret words, plus two kinds of names that hold a credential without
// saying so: a database connection string (DATABASE_URL, POSTGRES_URL and the
// variants the Neon integration injects carry the password) and an encryption
// key (WEBHOOK_TRIGGER_ENCRYPTION_KEY, which the MCP result sanitizer redacts).
const SECRET_ENVIRONMENT_KEY =
  /(?:password|secret|token|private[_-]?key|api[_-]?key|oauth|credential|encryption[_-]?key|(?:database|postgres)\w*url)/i;

export function configuredReplaySecrets(
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
