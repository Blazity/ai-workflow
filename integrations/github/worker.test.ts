import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

/**
 * What the Integrations page says about a GitHub connection.
 *
 * These checks were core's until S11 (`services/system/probes.ts`), where they
 * ran off `GITHUB_*` environment variables. They read a connection now, and the
 * cases below are the ones that were worth catching there: an installation that
 * grants nothing, an App subscribed to too few events, and a delivery GitHub
 * itself recorded as rejected.
 *
 * Octokit is replaced, and nothing else: the branch under test is the reading
 * of what GitHub answered, so a mock that decided anything about the outcome
 * would test itself.
 */
const octokit = vi.hoisted(() => ({
  apps: {
    getAuthenticated: vi.fn(),
    listReposAccessibleToInstallation: vi.fn(),
  },
  request: vi.fn(),
}));

vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  buildOctokit: () => octokit,
}));

const { runtime } = await import("./worker");

/** A real key, so the reader in front of every check passes on its own terms. */
const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const EVERY_EVENT = [
  "check_run",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
];

function context(
  overrides: Record<string, unknown> = {},
  webhookUrl: string | undefined = "https://worker.example/webhooks/github",
) {
  return {
    connection: {
      appId: 11,
      privateKey: PRIVATE_KEY,
      installationId: 22,
      webhookSecret: "webhook-secret",
      ...overrides,
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...(webhookUrl ? { webhookUrl } : {}),
  } as never;
}

/** What the App API answers: subscribed events, hook config, last delivery. */
function appAnswers(input: {
  events?: string[];
  insecureSsl?: string;
  deliveries?: Array<{ delivered_at?: string; status_code?: number }>;
}): void {
  octokit.apps.getAuthenticated.mockResolvedValue({
    data: { slug: "ai-workflow", events: input.events ?? EVERY_EVENT },
  });
  octokit.request.mockImplementation(async (route: string) => {
    if (route.includes("/app/hook/config")) {
      return {
        data: {
          url: "https://worker.example/webhooks/github",
          insecure_ssl: input.insecureSsl ?? "0",
        },
      };
    }
    if (route.includes("/app/hook/deliveries")) {
      return { data: input.deliveries ?? [] };
    }
    throw new Error(`Unexpected request: ${route}`);
  });
}

describe("the GitHub connection's health checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokit.apps.listReposAccessibleToInstallation.mockResolvedValue({
      data: { total_count: 3, repositories: [{}] },
    });
    appAnswers({});
  });

  it("does not call an installation that grants no repository live", async () => {
    // The credentials are perfectly valid here. Painting this live is how a
    // deployment that can authenticate and reach nothing reads as healthy right
    // up to the first run that fails to clone.
    octokit.apps.listReposAccessibleToInstallation.mockResolvedValue({
      data: { total_count: 0, repositories: [] },
    });

    await expect(runtime.health.installation?.(context())).resolves.toMatchObject({
      status: "degraded",
      message: expect.stringContaining("grants access to no repository"),
    });
  });

  it("reports an App subscribed to too few events, naming the missing ones", async () => {
    appAnswers({ events: ["pull_request"] });

    const result = await runtime.health.webhook?.(context());

    expect(result).toMatchObject({ status: "down" });
    for (const event of EVERY_EVENT.filter((event) => event !== "pull_request")) {
      expect(result?.message).toContain(event);
    }
  });

  it("reads a delivery GitHub rejected with 401 as a webhook secret mismatch", async () => {
    // The status code in that log is the one this worker answered with, so a
    // 401 there can mean nothing else. Without this an operator reads "the
    // webhook is configured" while every delivery is being thrown away.
    appAnswers({
      deliveries: [{ delivered_at: new Date().toISOString(), status_code: 401 }],
    });

    await expect(runtime.health.webhook?.(context())).resolves.toMatchObject({
      status: "down",
      message: expect.stringContaining("webhook secret differs"),
    });
  });

  it("accepts a configured webhook that has delivered nothing yet", async () => {
    const result = await runtime.health.webhook?.(context());

    expect(result).toMatchObject({
      status: "live",
      message: expect.stringContaining("has not delivered anything yet"),
    });
    expect(result?.message).toContain("https://worker.example/webhooks/github");
  });

  it("accepts a successful latest delivery, and says what it returned", async () => {
    appAnswers({
      deliveries: [{ delivered_at: new Date().toISOString(), status_code: 200 }],
    });

    await expect(runtime.health.webhook?.(context())).resolves.toMatchObject({
      status: "live",
      message: expect.stringContaining("returned 200"),
    });
  });

  it("refuses a webhook check on a connection with no secret, before asking GitHub", async () => {
    // Every delivery is refused in this state, and GitHub's own log would show
    // it as failing without saying why.
    const result = await runtime.health.webhook?.(context({ webhookSecret: undefined }));

    expect(result).toMatchObject({ status: "degraded" });
    expect(result?.message).toContain("No webhook secret is set");
    expect(octokit.apps.getAuthenticated).not.toHaveBeenCalled();
  });

  it("says so when the App is pointed at a different deployment", async () => {
    // This has happened on this project: an App left pointing at a previous
    // deployment answers every other check perfectly while nothing it sends
    // arrives. Waiting for core's delivery row to go quiet takes a week.
    appAnswers({
      deliveries: [{ delivered_at: new Date().toISOString(), status_code: 200 }],
    });

    const result = await runtime.health.webhook?.(
      context({}, "https://other.example/webhooks/github"),
    );

    expect(result).toMatchObject({ status: "down" });
    expect(result?.message).toContain("https://worker.example/webhooks/github");
    expect(result?.message).toContain("https://other.example/webhooks/github");
  });

  it("does not judge the URL when core cannot say its own address", async () => {
    // A deployment with no public URL configured is core's own row to report.
    // An empty expectation here would read as a mismatch on every App.
    const result = await runtime.health.webhook?.(context({}, undefined));

    expect(result).toMatchObject({ status: "live" });
  });

  it("ignores a trailing slash on either side", async () => {
    appAnswers({
      deliveries: [{ delivered_at: new Date().toISOString(), status_code: 200 }],
    });

    await expect(
      runtime.health.webhook?.(context({}, "https://worker.example/webhooks/github/")),
    ).resolves.toMatchObject({ status: "live" });
  });

  it("reads a 5xx this deployment answered as busy, not as a broken App", async () => {
    // The worker answers 5xx when a dispatch failed on its side. Painting the
    // App down for a week over our own answer sends an operator to GitHub to
    // fix something that is not broken there.
    appAnswers({
      deliveries: [{ delivered_at: new Date().toISOString(), status_code: 503 }],
    });

    await expect(runtime.health.webhook?.(context())).resolves.toMatchObject({
      status: "degraded",
      message: expect.stringContaining("answered 503 by this deployment"),
    });
  });

  it("switched-off TLS verification is down, whatever the deliveries say", async () => {
    appAnswers({
      insecureSsl: "1",
      deliveries: [{ delivered_at: new Date().toISOString(), status_code: 200 }],
    });

    await expect(runtime.health.webhook?.(context())).resolves.toMatchObject({
      status: "down",
      message: expect.stringContaining("TLS verification switched off"),
    });
  });
});
