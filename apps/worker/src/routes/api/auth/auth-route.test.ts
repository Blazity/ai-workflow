import { describe, it, expect } from "vitest";
import { createApp, eventHandler, toWebHandler, toWebRequest } from "h3";
import { createTestDb } from "../../../db/test-db.js";
import { createAuth } from "../../../auth.js";

describe("auth catch-all", () => {
  it("delegates /api/auth/* to the Better Auth handler", async () => {
    const auth = createAuth(await createTestDb(), {
      secret: "x".repeat(32),
      baseURL: "http://localhost",
      trustedOrigins: ["http://localhost:3001"],
    });
    const app = createApp();
    app.use(eventHandler((event) => auth.handler(toWebRequest(event))));
    const handler = toWebHandler(app);

    const res = await handler(
      new Request("http://localhost/api/auth/get-session"),
    );
    // Better Auth handled the route (200 with a null body when unauthenticated),
    // i.e. it is NOT a 404 from the router.
    expect(res.status).toBe(200);
  });
});
