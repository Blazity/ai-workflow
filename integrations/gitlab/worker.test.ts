import { describe, expect, it, vi } from "vitest";

import { runtime } from "./worker";

/**
 * What an admin reads after pressing Test on a GitLab connection, and what the
 * card does next.
 *
 * `{ ok: false }` makes the card Failing and stops every run that needs GitLab;
 * a throw is filed as GitLab being unreachable and leaves the card as it was.
 * GitLab's own table says 401 is a token that does not authenticate and 403 a
 * request the token is not allowed; 429 is its rate limit and 5xx its side. The
 * test used to catch every error and call it a refused token.
 *
 * Only `ctx.http.fetch` is replaced: it is the provider boundary.
 */
type Answer = (url: URL) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const healthy: Answer = (url) => {
  if (url.pathname === "/api/v4/user") return json(200, { username: "ai-bot" });
  if (url.pathname === "/api/v4/projects") return json(200, [{ id: 1 }], { "x-total": "3" });
  return json(404, { message: "404 Not Found" });
};

function context(answer: Answer) {
  const fetch = vi.fn(async (input: unknown) => answer(new URL(String(input))));
  return {
    ctx: {
      connection: { token: "glpat-secret", host: "https://gitlab.example/" },
      http: { fetch },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      signal: new AbortController().signal,
    } as never,
    fetch,
  };
}

describe("the GitLab connection test", () => {
  it("names the account and counts its projects from one page", async () => {
    const { ctx, fetch } = context(healthy);

    await expect(runtime.testConnection(ctx)).resolves.toEqual({
      ok: true,
      message: "Connected as ai-bot; 3 projects visible.",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a token GitLab does not authenticate", async () => {
    const { ctx } = context((url) =>
      url.pathname === "/api/v4/user" ? json(401, { message: "401 Unauthorized" }) : healthy(url),
    );

    await expect(runtime.testConnection(ctx)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("refused the token (401"),
    });
  });

  it("refuses a token that cannot read projects", async () => {
    const { ctx } = context((url) =>
      url.pathname === "/api/v4/projects" ? json(403, { error: "insufficient_scope" }) : healthy(url),
    );

    await expect(runtime.testConnection(ctx)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("read_api"),
    });
  });

  for (const status of [429, 500, 503]) {
    it(`throws, rather than refusing, when GitLab answers ${status}`, async () => {
      const { ctx } = context((url) =>
        url.pathname === "/api/v4/user" ? json(status, { message: "busy" }) : healthy(url),
      );

      await expect(runtime.testConnection(ctx)).rejects.toThrow(String(status));
    });
  }

  it("throws, rather than refusing, when GitLab cannot be reached", async () => {
    const { ctx } = context(() => {
      throw new TypeError("fetch failed");
    });

    await expect(runtime.testConnection(ctx)).rejects.toThrow("fetch failed");
  });
});

describe("the GitLab health rows", () => {
  it("say GitLab did not answer rather than blaming the token", async () => {
    const { ctx } = context(() => json(502, { message: "Bad Gateway" }));

    await expect(runtime.health.api(ctx)).resolves.toEqual({
      status: "down",
      message: "GitLab did not answer (502), so this could not be checked.",
    });
  });

  it("blame the token when GitLab refused it", async () => {
    const { ctx } = context(() => json(401, { message: "401 Unauthorized" }));

    await expect(runtime.health.api(ctx)).resolves.toEqual({
      status: "down",
      message: "GitLab refused the token (401).",
    });
  });

  it("say when there are more projects than GitLab will count", async () => {
    const { ctx } = context((url) =>
      url.pathname === "/api/v4/projects" ? json(200, [{ id: 1 }]) : healthy(url),
    );

    await expect(runtime.health.projects(ctx)).resolves.toEqual({
      status: "live",
      message: "The token sees more than 10,000 projects.",
    });
  });
});
