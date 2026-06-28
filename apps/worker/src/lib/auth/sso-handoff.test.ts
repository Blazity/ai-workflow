import { describe, expect, it } from "vitest";

import { createAuth, seedAuthUser } from "../../auth.js";
import { createTestDb } from "../../db/test-db.js";
import {
  consumeDashboardSsoHandoff,
  createDashboardSsoHandoff,
} from "./sso-handoff.js";

const OPTS = {
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};

function tokenFrom(res: { headers: Headers; response: unknown }): string {
  return (
    res.headers.get("set-auth-token") ??
    (res.response as { token?: string }).token ??
    ""
  );
}

describe("SSO handoff", () => {
  it("creates a one-time handoff token for an existing Better Auth session", async () => {
    const auth = createAuth(await createTestDb(), OPTS);
    await seedAuthUser(auth, { email: "owner@example.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "owner@example.com", password: "password123" },
      returnHeaders: true,
    });
    const sessionToken = tokenFrom(signIn);

    const handoffToken = await createDashboardSsoHandoff(auth, sessionToken);
    await expect(consumeDashboardSsoHandoff(auth, handoffToken)).resolves.toEqual({
      sessionToken,
    });
    await expect(consumeDashboardSsoHandoff(auth, handoffToken)).rejects.toThrow(
      "Invalid SSO handoff token",
    );
  });

  it("rejects expired handoff tokens", async () => {
    const auth = createAuth(await createTestDb(), OPTS);
    await seedAuthUser(auth, { email: "owner@example.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "owner@example.com", password: "password123" },
      returnHeaders: true,
    });

    const handoffToken = await createDashboardSsoHandoff(
      auth,
      tokenFrom(signIn),
      new Date(Date.now() - 120_000),
    );

    await expect(consumeDashboardSsoHandoff(auth, handoffToken)).rejects.toThrow(
      "Invalid SSO handoff token",
    );
  });
});
