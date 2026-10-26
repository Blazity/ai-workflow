import { describe, expect, it, vi } from "vitest";
import { runtime } from "./worker";

const WEBHOOK_URL = "https://worker.example/webhooks/linear";

type Handler = (body: string) => Response | undefined;

function context(
  handler: Handler,
  overrides: {
    webhookUrl?: string;
    apiToken?: string;
    projectKey?: string;
  } = {},
) {
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const answer = handler(bodyStr);
    if (!answer) throw new Error(`Unexpected request with body: ${bodyStr}`);
    return answer;
  });

  return {
    connection: {
      apiToken: "apiToken" in overrides ? overrides.apiToken! : "lin_api_test_key",
      projectKey: "projectKey" in overrides ? overrides.projectKey! : "CUK",
    },
    signal: new AbortController().signal,
    webhookUrl: "webhookUrl" in overrides ? overrides.webhookUrl : WEBHOOK_URL,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: { fetch },
  } as never;
}

function viewerResponse(id = "user-1"): Response {
  return Response.json({ data: { viewer: { id, name: "Test User", email: "test@example.com" } } });
}

function statesResponse(states: Array<{ id: string; name: string }>): Response {
  return Response.json({
    data: {
      teams: {
        nodes: [
          {
            id: "team-1",
            key: "CUK",
            name: "Cukorborsok",
            states: {
              nodes: states.map((s, idx) => ({ id: s.id, name: s.name, type: "started", position: idx })),
            },
          },
        ],
      },
    },
  });
}

function webhooksResponse(
  registrations: Array<{ url: string; enabled: boolean; resourceTypes: string[] }> | number,
): Response {
  return typeof registrations === "number"
    ? new Response(null, { status: registrations })
    : Response.json({
        data: {
          webhooks: {
            nodes: registrations.map((r, idx) => ({
              id: `wh-${idx}`,
              url: r.url,
              enabled: r.enabled,
              resourceTypes: r.resourceTypes,
            })),
          },
        },
      });
}

const probe = (id: "api" | "project" | "webhook-registration") => runtime.health![id]!;

describe("the Linear integration's health checks", () => {
  it("names an API key Linear did not accept, without blaming the team", async () => {
    const result = await probe("api")(
      context((body) => {
        if (body.includes("Viewer")) {
          return new Response(null, { status: 401 });
        }
        return undefined;
      }),
    );

    expect(result).toEqual({
      status: "down",
      message: "Linear authentication failed: the API key was not accepted.",
    });
  });

  it("reports the API key as accepted when Linear answers for the account", async () => {
    const result = await probe("api")(
      context((body) => {
        if (body.includes("Viewer")) return viewerResponse();
        return undefined;
      }),
    );

    expect(result).toMatchObject({
      status: "live",
      message: "Linear accepts the API key.",
    });
  });

  it("reports outage when Linear does not answer for the account", async () => {
    const result = await probe("api")(
      context((body) => {
        if (body.includes("Viewer")) return new Response(null, { status: 503 });
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("Linear did not answer");
  });

  it("reports team visible with workflow states", async () => {
    const result = await probe("project")(
      context((body) => {
        if (body.includes("TeamStates")) {
          return statesResponse([
            { id: "s1", name: "Backlog" },
            { id: "s2", name: "In Progress" },
          ]);
        }
        return undefined;
      }),
    );

    expect(result).toMatchObject({
      status: "live",
      message: "Team CUK is visible, with 2 workflow states to move issues between.",
    });
  });

  it("reports team down when it has no workflow states", async () => {
    const result = await probe("project")(
      context((body) => {
        if (body.includes("TeamStates")) return statesResponse([]);
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("has no workflow states");
  });

  it("reports team down on provider outage", async () => {
    const result = await probe("project")(
      context(() => {
        throw new Error("network timeout");
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain(
      "Linear did not answer, so team CUK could not be checked",
    );
  });

  it("reports webhook live when correctly registered and enabled", async () => {
    const result = await probe("webhook-registration")(
      context((body) => {
        if (body.includes("Webhooks")) {
          return webhooksResponse([{ url: WEBHOOK_URL, enabled: true, resourceTypes: ["Issue", "Comment"] }]);
        }
        return undefined;
      }),
    );

    expect(result).toMatchObject({
      status: "live",
      message: `Linear calls ${WEBHOOK_URL} on issue and comment updates.`,
    });
  });

  it("reports webhook down when not found", async () => {
    const result = await probe("webhook-registration")(
      context((body) => {
        if (body.includes("Webhooks")) {
          return webhooksResponse([{ url: "https://other.url", enabled: true, resourceTypes: ["Issue", "Comment"] }]);
        }
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("No Linear webhook points at");
  });

  it("reports webhook down when disabled", async () => {
    const result = await probe("webhook-registration")(
      context((body) => {
        if (body.includes("Webhooks")) {
          return webhooksResponse([{ url: WEBHOOK_URL, enabled: false, resourceTypes: ["Issue", "Comment"] }]);
        }
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("switched off");
  });

  it("reports webhook down when missing Issue event", async () => {
    const result = await probe("webhook-registration")(
      context((body) => {
        if (body.includes("Webhooks")) {
          return webhooksResponse([{ url: WEBHOOK_URL, enabled: true, resourceTypes: ["Comment"] }]);
        }
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("does not send Issue events");
  });

  it("reports webhook down when missing Comment event", async () => {
    const result = await probe("webhook-registration")(
      context((body) => {
        if (body.includes("Webhooks")) {
          return webhooksResponse([{ url: WEBHOOK_URL, enabled: true, resourceTypes: ["Issue"] }]);
        }
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("does not send Comment events");
  });

  it("reports webhook down when missing both Issue and Comment events", async () => {
    const result = await probe("webhook-registration")(
      context((body) => {
        if (body.includes("Webhooks")) {
          return webhooksResponse([{ url: WEBHOOK_URL, enabled: true, resourceTypes: [] }]);
        }
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "down" });
    expect((result as { message: string }).message).toContain("does not send Issue and Comment events");
  });

  it("reports webhook degraded when user has no permission to list webhooks", async () => {
    const result = await probe("webhook-registration")(
      context((body) => {
        if (body.includes("Webhooks")) return webhooksResponse(403);
        return undefined;
      }),
    );

    expect(result).toMatchObject({ status: "degraded" });
    expect((result as { message: string }).message).toContain("cannot list Linear's webhooks");
  });

  it("reports webhook degraded when worker has no public URL", async () => {
    const result = await probe("webhook-registration")(
      context(() => undefined, { webhookUrl: "" }),
    );

    expect(result).toMatchObject({ status: "degraded" });
    expect((result as { message: string }).message).toContain("no public URL");
  });
});

describe("the Linear integration's connection test", () => {
  it("refuses malformed API token with whitespace", async () => {
    const result = await runtime.testConnection!(
      context(() => undefined, { apiToken: "lin_api key_with_space" }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "The API key must not contain whitespace or newline characters.",
      malformed: true,
    });
  });

  it("refuses empty team key", async () => {
    const result = await runtime.testConnection!(
      context(() => undefined, { projectKey: "" }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "The Team key is required.",
      malformed: true,
    });
  });

  it("passes when valid account and statuses are found", async () => {
    const result = await runtime.testConnection!(
      context((body) => {
        if (body.includes("Viewer")) return viewerResponse("acc-123");
        if (body.includes("TeamStates")) {
          return statesResponse([
            { id: "s1", name: "Backlog" },
            { id: "s2", name: "In Progress" },
          ]);
        }
        return undefined;
      }),
    );

    expect(result).toEqual({
      ok: true,
      message: "Connected to CUK, 2 statuses visible.",
    });
  });

  it("refuses when account works but team has no workflow states", async () => {
    const result = await runtime.testConnection!(
      context((body) => {
        if (body.includes("Viewer")) return viewerResponse("acc-123");
        if (body.includes("TeamStates")) return statesResponse([]);
        return undefined;
      }),
    );

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("has no workflow states");
  });

  it("refuses credentials Linear does not accept", async () => {
    const result = await runtime.testConnection!(
      context((body) => {
        if (body.includes("Viewer")) return new Response(null, { status: 401 });
        return undefined;
      }),
    );

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("Linear did not accept this API key");
  });

  it("throws when Linear is in outage", async () => {
    await expect(
      runtime.testConnection!(
        context((body) => {
          if (body.includes("Viewer")) return new Response(null, { status: 503 });
          return undefined;
        }),
      ),
    ).rejects.toThrow(/503/u);
  });
});
