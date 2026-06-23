import { describe, it, expect } from "vitest";
import { createTestDb } from "./db/test-db.js";
import { createAuth, seedAuthUser, type Auth } from "./auth.js";

const OPTS = {
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};

async function freshAuth(): Promise<Auth> {
  return createAuth(await createTestDb(), OPTS);
}

function tokenFrom(res: { headers: Headers; response: unknown }): string {
  return (
    res.headers.get("set-auth-token") ??
    (res.response as { token?: string }).token ??
    ""
  );
}

describe("seedAuthUser", () => {
  it("creates the user when absent", async () => {
    const auth = await freshAuth();
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    expect(r).toEqual({ created: true, updated: false });
  });

  it("is idempotent — no duplicate, no change on re-run", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    expect(r).toEqual({ created: false, updated: false });
    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail("admin@x.com");
    expect(found).not.toBeNull();
  });

  it("re-hashes when the password changes", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "newpassword456" });
    expect(r).toEqual({ created: false, updated: true });

    await expect(
      auth.api.signInEmail({ body: { email: "admin@x.com", password: "password123" } }),
    ).rejects.toThrow();

    const ok = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "newpassword456" },
      returnHeaders: true,
    });
    expect(tokenFrom(ok)).toBeTruthy();
  });
});

describe("bearer round-trip", () => {
  it("accepts a valid bearer and rejects bad/missing", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    const token = tokenFrom(signIn);
    expect(token).toBeTruthy();

    const good = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(good?.user.email).toBe("admin@x.com");

    const bad = await auth.api.getSession({
      headers: new Headers({ authorization: "Bearer nope" }),
    });
    expect(bad).toBeNull();
  });
});
