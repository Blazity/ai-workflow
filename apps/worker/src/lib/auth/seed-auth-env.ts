const REQUIRED_ENV = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "DASHBOARD_ORIGIN",
  "DASHBOARD_AUTH_EMAIL",
  "DASHBOARD_AUTH_PASSWORD",
] as const;

const OPTIONAL_ENV = [
  "DASHBOARD_ORG_NAME",
  "DASHBOARD_ORG_SLUG",
  "SSO_ISSUER",
  "SSO_ALLOWED_DOMAIN",
  "SSO_CLIENT_ID",
  "SSO_CLIENT_SECRET",
] as const;

type RequiredEnvName = (typeof REQUIRED_ENV)[number];
type OptionalEnvName = (typeof OPTIONAL_ENV)[number];

export type ResolvedSeedAuthEnv = {
  values: Partial<Record<RequiredEnvName | OptionalEnvName, string>>;
  missingRequiredEnv: RequiredEnvName[];
};

export function resolveSeedAuthEnv(env: NodeJS.ProcessEnv): ResolvedSeedAuthEnv {
  const values: ResolvedSeedAuthEnv["values"] = {};

  for (const name of [...REQUIRED_ENV, ...OPTIONAL_ENV]) {
    const value = env[name]?.trim();
    if (value) values[name] = value;
  }

  return {
    values,
    missingRequiredEnv: REQUIRED_ENV.filter((name) => !values[name]),
  };
}
