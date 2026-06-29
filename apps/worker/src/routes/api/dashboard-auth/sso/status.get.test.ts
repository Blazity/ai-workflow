import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_SSO_PROVIDER_ID } from "../../../../auth.js";
import type { Db } from "../../../../db/client.js";
import { ssoProvider, user } from "../../../../db/schema.js";
import { createTestDb } from "../../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
}));

vi.mock("../../../../db/client.js", () => ({
  getDb: () => state.db,
}));

const statusRoute = (await import("./status.get.js")).default;

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

describe("SSO status API", () => {
  it("reports disabled when the fixed SSO provider is absent", async () => {
    const res = await handlerFor(statusRoute)(new Request("http://localhost/"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: false });
  });

  it("reports enabled when the fixed SSO provider exists", async () => {
    await db.insert(user).values({
      id: "user_owner",
      name: "Owner",
      email: "owner@example.com",
      emailVerified: true,
    });
    await db.insert(ssoProvider).values({
      id: "sso_workspace",
      issuer: "https://accounts.google.com",
      oidcConfig: "{}",
      samlConfig: null,
      userId: "user_owner",
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      organizationId: null,
      domain: "example.com",
      domainVerified: true,
    });

    const res = await handlerFor(statusRoute)(new Request("http://localhost/"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: true });
  });
});
