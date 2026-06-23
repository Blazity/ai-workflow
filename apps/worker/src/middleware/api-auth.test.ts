import { describe, it, expect, vi } from "vitest";
import { createApp, eventHandler, toWebHandler } from "h3";
import { createTestDb } from "../db/test-db.js";
import { createAuth, seedAuthUser, assertSession, type Auth } from "../auth.js";

vi.mock("../auth-instance.js", () => {
  const getSession = vi.fn(async () => null);
  return { auth: { api: { getSession } } };
});

async function authWithUser(): Promise<Auth> {
  const auth = createAuth(await createTestDb(), {
    secret: "x".repeat(32),
    baseURL: "http://localhost",
    trustedOrigins: ["http://localhost:3001"],
  });
  await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
  return auth;
}

describe("assertSession (the /api/v1 gate)", () => {
  it("passes for a valid session bearer", async () => {
    const auth = await authWithUser();
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    const token =
      signIn.headers.get("set-auth-token") ??
      (signIn.response as { token?: string }).token;
    if (!token) throw new Error("sign-in returned no session token");
    await expect(
      assertSession(auth, new Headers({ authorization: `Bearer ${token}` })),
    ).resolves.toBeUndefined();
  });

  it("throws 401 when the bearer is missing or invalid", async () => {
    const auth = await authWithUser();
    await expect(assertSession(auth, new Headers())).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      assertSession(auth, new Headers({ authorization: "Bearer nope" })),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("api-auth middleware routing guard", () => {
  async function makeApp() {
    const middleware = (await import("./api-auth.js")).default;
    const app = createApp();
    app.use(middleware);
    app.use(eventHandler(() => "ok"));
    return toWebHandler(app);
  }

  it("does NOT gate non-/api/v1/ paths (e.g. /cron/poll)", async () => {
    const { auth: fakeAuth } = await import("../auth-instance.js");
    const getSession = fakeAuth.api.getSession as ReturnType<typeof vi.fn>;
    getSession.mockClear();

    const handler = await makeApp();
    const res = await handler(new Request("http://localhost/cron/poll"));

    expect(res.status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("gates /api/v1/ paths with no session → 401", async () => {
    const { auth: fakeAuth } = await import("../auth-instance.js");
    const getSession = fakeAuth.api.getSession as ReturnType<typeof vi.fn>;
    getSession.mockClear();
    getSession.mockResolvedValue(null);

    const handler = await makeApp();
    const res = await handler(new Request("http://localhost/api/v1/runs"));

    expect(res.status).toBe(401);
    expect(getSession).toHaveBeenCalled();
  });
});
