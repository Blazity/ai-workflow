import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A push the integration did not attribute.
 *
 * `pusher` is required on the legacy gate, and required in TypeScript is not
 * required at runtime: an integration is ordinary JavaScript written outside
 * this repository, and the field it never sets arrives as `undefined`. The
 * fallback this replaced read the pull request's author, which on a pull
 * request this product opened is always our own automation account, so an
 * integration that simply did not set the field suppressed every human push
 * and skipped the post-PR gate on it, with nothing going red.
 *
 * So the rule proved here is the safe direction: no attribution, no
 * suppression, and the gate runs. Checking a change twice costs a run; not
 * checking somebody's change costs the review the gate exists for.
 *
 * The registry is replaced here and nowhere else, because the point is an
 * integration this build does not ship. Everything the route decides is real.
 */
const state = vi.hoisted(() => ({
  pushSuppressionInputs: [] as Record<string, unknown>[],
  suppressPush: true,
  gate: vi.fn(async () => ({ status: "dispatched", runId: "gate-run" })),
  dispatch: vi.fn(async () => ({ result: "started", runId: "run-1" })),
  pusher: undefined as string | undefined,
}));

const WORKFLOW_INPUT = {
  prNumber: 318,
  headSha: "a-head-this-run-published",
  headRef: "ai-workflow/awp-26",
  baseRef: "main",
  title: "Fix the callback",
  body: "",
  // Our own account, which is what makes the deleted fallback dangerous.
  author: "ai-workflow-bot",
  isDraft: false,
  url: "https://example.invalid/acme/app/pull/318",
  ownerRepo: "acme/app",
  provider: "demo-vcs",
};

const MANIFEST = {
  id: "demo-vcs",
  name: "Demo VCS",
  capabilities: ["vcs"],
  connection: { fields: [] },
};

vi.mock("@integrations/registry", () => ({
  integrationManifest: (id: string) => (id === MANIFEST.id ? MANIFEST : undefined),
}));

vi.mock("@integrations/registry/worker", () => ({
  integrationRuntime: (id: string) =>
    id === MANIFEST.id
      ? {
          webhook: {
            receive: async () => ({
              kind: "trigger_events",
              events: [],
              response: { status: 202, body: { status: "ignored" } },
              legacyGate: {
                action: "synchronize",
                headMoved: true,
                ...(state.pusher ? { pusher: state.pusher } : {}),
                workflowInput: WORKFLOW_INPUT,
              },
            }),
          },
        }
      : undefined,
}));

vi.mock("../../services/integrations/runtime.js", () => ({
  resolveUsableIntegrations: async () => ({
    readable: true,
    usable: [
      {
        manifest: MANIFEST,
        ctx: { connection: {}, signal: new AbortController().signal },
      },
    ],
    states: new Map([[MANIFEST.id, { enabled: true }]]),
  }),
}));
vi.mock("../../services/settings/index.js", () => ({
  getRequestSettingsSnapshot: async () => ({ MAX_CONCURRENT_AGENTS: 3 }),
  maxConcurrentAgents: () => 3,
}));
vi.mock("../../services/repository-catalog/index.js", () => ({
  getRequestRepositoryCatalogSnapshot: async () => ({ activated: false }),
}));
vi.mock("../../services/dispatch/index.js", () => ({
  createConnectedTriggerRunRegistry: () => ({}),
  dispatchTriggerEvent: state.dispatch,
  dispatchPostPrGateWebhook: state.gate,
  isRepositoryDispatchable: () => true,
}));
vi.mock("../../services/publication/index.js", () => ({
  connectedWorkflowPushNormalizationOptions: async () => ({
    workflowPublishedHeadSha: "a-head-this-run-published",
    workflowOwnedPullRequest: true,
  }),
  isWorkflowGeneratedPush: (input: Record<string, unknown>) => {
    state.pushSuppressionInputs.push(input);
    return state.suppressPush;
  },
}));
vi.mock("../../services/vcs/index.js", () => ({
  getVcsBotLogin: async () => "ai-workflow-bot",
  readVcsBotLogin: async () => ({ readable: true, login: "ai-workflow-bot" }),
}));
vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));
vi.mock("../../services/system/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/system/observations.js", () => ({
  recordSystemHealthObservation: async () => {},
}));

const deferred: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    deferred.push(promise);
  },
}));

const handler = (await import("./[id].post.js")).default;
const { logger } = await import("../../services/system/logger.js");

function app() {
  const router = createRouter();
  router.post("/webhooks/:id", handler);
  return toWebHandler(createApp().use(router));
}

function delivery(): Request {
  return new Request("http://localhost/webhooks/demo-vcs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ any: "payload" }),
  });
}

describe("a legacy gate that names no pusher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pushSuppressionInputs = [];
    state.suppressPush = true;
    state.pusher = undefined;
    deferred.length = 0;
  });

  it("suppresses nothing and lets the gate run", async () => {
    const response = await app()(delivery());
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    // The predicate is never consulted, so a predicate that would have said
    // "ours" cannot decide anything here.
    expect(state.pushSuppressionInputs).toEqual([]);
    expect(state.gate).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "demo-vcs" }),
      "webhook_push_author_unknown",
    );
  });

  it("asks the predicate as soon as the integration does attribute the push", async () => {
    state.pusher = "filip";

    await app()(delivery());
    await Promise.all(deferred);

    expect(state.pushSuppressionInputs).toEqual([
      expect.objectContaining({ producer: "filip" }),
    ]);
    expect(state.gate).not.toHaveBeenCalled();
  });
});
