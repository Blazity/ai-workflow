import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp, toWebHandler } from "h3";

const state = vi.hoisted(() => ({
  authHandler: vi.fn(),
}));

vi.mock("../../../auth-instance.js", () => ({
  auth: {
    handler: state.authHandler,
  },
}));

const authRoute = (await import("./[...all].js")).default;

beforeEach(() => {
  vi.clearAllMocks();
  state.authHandler.mockResolvedValue(Response.json(null));
});

describe("auth catch-all", () => {
  it("delegates /api/auth/* to the Better Auth handler", async () => {
    const app = createApp();
    app.use("/", authRoute);
    const handler = toWebHandler(app);

    const res = await handler(
      new Request("http://localhost/api/auth/get-session"),
    );
    // Better Auth handled the route (200 with a null body when unauthenticated),
    // i.e. it is NOT a 404 from the router.
    expect(res.status).toBe(200);
    expect(state.authHandler).toHaveBeenCalledOnce();
  });
});
