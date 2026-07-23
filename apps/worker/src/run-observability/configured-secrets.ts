const SECRET_ENVIRONMENT_KEY =
  /(?:password|secret|token|private[_-]?key|api[_-]?key|oauth|credential)/i;

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
