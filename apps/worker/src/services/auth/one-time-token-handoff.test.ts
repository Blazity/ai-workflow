import { like } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createAuth, seedAuthUser } from "../../auth.js";
import { verification } from "../../db/auth-schema.js";
import { createTestDb } from "../../db/test-db.js";

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

describe("Better Auth one-time MCP session handoff", () => {
  it("bridges a bearer session, then rejects the consumed token on replay", async () => {
    const auth = createAuth(await createTestDb(), OPTS);
    await seedAuthUser(auth, { email: "owner@example.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "owner@example.com", password: "password123" },
      returnHeaders: true,
    });
    const sessionToken = tokenFrom(signIn);

    const generated = await auth.api.generateOneTimeToken({
      headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
    });
    expect(generated.token).not.toBe(sessionToken);
    expect(generated.token).toMatch(/^[A-Za-z0-9_-]{20,256}$/);

    const verified = await auth.api.verifyOneTimeToken({
      body: { token: generated.token },
      returnHeaders: true,
    });
    expect(verified.response.user.email).toBe("owner@example.com");
    expect(verified.headers.get("set-cookie")).toContain("better-auth.session_token");

    await expect(
      auth.api.verifyOneTimeToken({ body: { token: generated.token } }),
    ).rejects.toThrow("Invalid token");
  });

  it("rejects absent, invalid, and expired handoffs", async () => {
    const db = await createTestDb();
    const auth = createAuth(db, OPTS);
    await seedAuthUser(auth, { email: "owner@example.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "owner@example.com", password: "password123" },
      returnHeaders: true,
    });
    const sessionToken = tokenFrom(signIn);

    await expect(
      auth.api.generateOneTimeToken({ headers: new Headers() }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      auth.api.verifyOneTimeToken({ body: { token: "missing-token-1234567890" } }),
    ).rejects.toThrow("Invalid token");

    const generated = await auth.api.generateOneTimeToken({
      headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
    });
    const [stored] = await db
      .select()
      .from(verification)
      .where(like(verification.identifier, "one-time-token:%"));
    if (!stored) throw new Error("one-time handoff was not stored");
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(like(verification.identifier, stored.identifier));

    await expect(
      auth.api.verifyOneTimeToken({ body: { token: generated.token } }),
    ).rejects.toThrow("Invalid token");
  });
});
