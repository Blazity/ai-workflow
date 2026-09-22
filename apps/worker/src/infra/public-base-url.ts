/**
 * The public address this deployment answers at, without a trailing slash, or
 * nothing when none is configured.
 *
 * One reader, because two answers derive from it and must agree about which
 * deployment they describe: where an integration's webhooks arrive
 * (`/webhooks/<id>` under this base), and whose webhook deliveries the health
 * page reports. Deployments that share one database (demo shares
 * production's) differ here and nowhere else core may look.
 *
 * Not yet the only reader: `integrationWebhookUrl` in
 * `services/integrations/context.ts` still reads `BETTER_AUTH_URL` with the
 * same trim itself. That file belongs to the connections branch, and it calls
 * this function when the two branches are assembled.
 *
 * Read off `process.env` rather than the validated environment module, so a
 * module reached from the integrations barrel can call it: importing
 * environment validation there fails wherever the variables are not set. The
 * value is a URL a person typed, and nothing here depends on its shape beyond
 * being non-empty.
 */
export function deploymentPublicBaseUrl(): string | undefined {
  const base = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/u, "");
  return base ? base : undefined;
}
