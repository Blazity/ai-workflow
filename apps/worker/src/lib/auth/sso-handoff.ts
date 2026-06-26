import { randomUUID } from "node:crypto";

import type { Auth } from "../../auth.js";
import { DashboardAuthError } from "./users-read.js";

const HANDOFF_PREFIX = "dashboard-sso-handoff:";
const HANDOFF_TTL_MS = 60 * 1000;

export async function createDashboardSsoHandoff(
  auth: Auth,
  sessionToken: string,
  now = new Date(),
): Promise<string> {
  const handoffToken = randomUUID();
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: handoffIdentifier(handoffToken),
    value: sessionToken,
    expiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
  });
  return handoffToken;
}

export async function consumeDashboardSsoHandoff(
  auth: Auth,
  handoffToken: string,
): Promise<{ sessionToken: string }> {
  if (!handoffToken) {
    throw new DashboardAuthError(400, "Missing SSO handoff token");
  }

  const ctx = await auth.$context;
  const consumed = await ctx.internalAdapter.consumeVerificationValue(
    handoffIdentifier(handoffToken),
  );
  if (!consumed) {
    throw new DashboardAuthError(401, "Invalid SSO handoff token");
  }

  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${consumed.value}` }),
  });
  if (!session) {
    throw new DashboardAuthError(401, "Invalid SSO session");
  }

  return { sessionToken: consumed.value };
}

function handoffIdentifier(token: string): string {
  return `${HANDOFF_PREFIX}${token}`;
}
