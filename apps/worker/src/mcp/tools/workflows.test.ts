import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 65_536,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    MAX_CONCURRENT_AGENTS: 4,
  },
}));

// Seam S3: the dispatch domain keeps its own rules and its own tests, so these
// tools are exercised against a fake of it. That is what makes "exactly one
// service call" and "recovering" observable at all.
const service = vi.hoisted(() => ({
  preflightManualDispatch: vi.fn(),
  dispatchManualWorkflow: vi.fn(),
}));
vi.mock("../../manual-dispatch/service.js", () => service);

import type { Adapters } from "../../lib/adapters.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { mcpAuditEvents, organization } from "../../db/schema.js";
import { ManualDispatchError } from "../../manual-dispatch/errors.js";
import type { McpActorContext } from "../contracts.js";
import { actorFor, depsFor } from "../test-support.js";
import { registerWorkflowTools } from "./workflows.js";

const ORG_ID = "org-execute";

// Computed outside the repo (sha256 over the hand-sorted canonical JSON of
// {definitionId:7, deployedVersion:3, input:{kind:"ticket", ticketKey:"PROJ-1"},
// triggerNodeId:"trigger-1"}), so a digest built the wrong way in the
// implementation cannot agree with itself here and pass.
const DIGEST_PROJ1_V3 =
  "sha256:6f3960b3f534821583215d42355193c2247b37c3db9cb850a43f8a6838916a36";
const DIGEST_PROJ2_V3 =
  "sha256:2144859b41adcbccf29c6e0e37005bdb10677f68d61a6aa3d679877ea52486c8";
const DIGEST_PROJ1_V4 =
  "sha256:78e642e271163c57f26f4d6ac8a810776ebf500014e11aeb165ebe5887c8cac5";
// The same tuple with the ticket key exactly as an agent might send it, and with
// a pull request URL the provider would echo back differently: the digest has to
// be over the bytes the agent sent, or it is unreproducible on its side.
const DIGEST_LOWER_PROJ1_V3 =
  "sha256:491c1a8f56975eafe00d4fa0db299bd2d90d2e0665b985a6310d9fe5ddf234ca";
const DIGEST_PR_DIFFS_V3 =
  "sha256:32612256a82b3ed4f512e85ee1bfacab6674d7b348449842dd5758d84fca3ed1";

let db: Db;
let now: Date;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
  now = new Date("2026-08-12T12:00:00.000Z");
  service.preflightManualDispatch.mockReset();
  service.dispatchManualWorkflow.mockReset();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(actor: Partial<McpActorContext> = {}) {
  const server = new McpServer({ name: "workflows-test", version: "0.1.0" });
  registerWorkflowTools(
    server,
    // `now` is read through the closure so a single client can act twice a day
    // apart, which is what the idempotency reclaim case needs.
    depsFor(db, () => now, { actor: actorFor(actor), adapters: {} as Adapters }),
  );
  const client = new Client({ name: "workflows-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function preflightResponse(over: Record<string, unknown> = {}) {
  return {
    definitionId: 7,
    definitionName: "Ship it",
    deployedVersion: 3,
    triggerNodeId: "trigger-1",
    triggerType: "trigger_ticket_ai",
    input: { kind: "ticket", ticketKey: "PROJ-1" },
    subject: {
      kind: "ticket",
      key: "PROJ-1",
      title: "Add login page",
      currentStatus: "AI",
    },
    steps: [{ title: "Implementation agent", description: "Writes the code" }],
    runnable: true,
    ...over,
  };
}

const PREFLIGHT_ARGS = {
  definitionId: 7,
  triggerNodeId: "trigger-1",
  input: { kind: "ticket", ticketKey: "PROJ-1" },
};

const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

const DISPATCH_ARGS = {
  ...PREFLIGHT_ARGS,
  expectedDeployedVersion: 3,
  preflightDigest: DIGEST_PROJ1_V3,
  idempotencyKey: IDEMPOTENCY_KEY,
};

// UUID v8 with the RFC variant bits: the shape reserved for a value derived
// from application data rather than drawn at random.
const DERIVED_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Hands out a fresh run per call and echoes the requestId it was given, so a
 * second service call is visible both as a different run and as a different
 * dispatch request. */
function serviceStartsRuns(): void {
  let started = 0;
  service.dispatchManualWorkflow.mockImplementation(
    async (arg: { request: { requestId: string } }) => {
      started += 1;
      return {
        requestId: arg.request.requestId,
        status: "started",
        runId: `wrun_${started}`,
      };
    },
  );
}

/** The interesting fields of a dispatch call, lifted out one by one on purpose.
 * Asserting on the call object itself would put the pglite `db` and the adapters
 * into the failure diff, and serializing those runs the test runner out of
 * memory instead of printing what went wrong. */
function dispatchedWork(index = 0) {
  const call = service.dispatchManualWorkflow.mock.calls[index]?.[0] as {
    definitionId: number;
    triggerNodeId: string;
    request: { expectedDeployedVersion: number; input: unknown };
    actor: { label: string };
  };
  return {
    definitionId: call.definitionId,
    triggerNodeId: call.triggerNodeId,
    expectedDeployedVersion: call.request.expectedDeployedVersion,
    input: call.request.input,
    actorLabel: call.actor.label,
  };
}

function dispatchRequestIds(): string[] {
  return service.dispatchManualWorkflow.mock.calls.map(
    (call) => (call[0] as { request: { requestId: string } }).request.requestId,
  );
}

function errorText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
}

async function auditRows() {
  return db
    .select({ outcome: mcpAuditEvents.outcome, errorCode: mcpAuditEvents.errorCode })
    .from(mcpAuditEvents);
}

/** The mapped public code is read back off the audit row because the SDK's
 * tool-error path forwards only the thrown error's `message`, never its
 * `.code`. Only the refused row carries a code, so filtering keeps this
 * independent of row order: every row a test writes shares one `occurredAt`. */
async function auditedErrorCodes(): Promise<Array<string | null>> {
  return (await auditRows()).map((row) => row.errorCode).filter((code) => code !== null);
}

async function auditedOutcomes(): Promise<string[]> {
  return (await auditRows()).map((row) => row.outcome).sort();
}

describe("workflows.dispatch_preflight", () => {
  it("returns the dispatch digest, the deployed version, runnability and the blocker", async () => {
    service.preflightManualDispatch.mockResolvedValue(
      preflightResponse({
        runnable: false,
        blocker: { code: "at_capacity", message: "All slots are in use." },
      }),
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "workflows.dispatch_preflight",
      arguments: PREFLIGHT_ARGS,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        preflightDigest: DIGEST_PROJ1_V3,
        deployedVersion: 3,
        runnable: false,
        blocker: { code: "at_capacity" },
      },
      // Preflight echoes ticket titles and workflow names, which are somebody
      // else's text: it never gets promoted out of untrusted.
      meta: { trust: "external_untrusted" },
    });
  });

  it("maps a resolution blocker to its public code instead of a bare internal error", async () => {
    service.preflightManualDispatch.mockRejectedValue(
      new ManualDispatchError(422, "invalid_input", "Ticket PROJ-404 was not found."),
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "workflows.dispatch_preflight",
      arguments: PREFLIGHT_ARGS,
    });

    expect(result.isError).toBe(true);
    // The SDK forwards only the thrown error's `message`, never its `.code`, so
    // the mapped code is read back off the audit row instead.
    expect(errorText(result)).toBe("Ticket PROJ-404 was not found.");
    expect(await auditedOutcomes()).toEqual(["attempted", "rejected"]);
    expect(await auditedErrorCodes()).toEqual(["VALIDATION_FAILED"]);
  });
});

describe("workflows.dispatch", () => {
  it("repeating the same key returns the first run without dispatching twice", async () => {
    serviceStartsRuns();
    const client = await connectedClient();

    const first = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });
    const second = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const firstData = (first.structuredContent as { data: { runId: string; requestId: string } })
      .data;
    const secondData = (second.structuredContent as { data: { runId: string; requestId: string } })
      .data;
    expect(firstData.runId).toBe("wrun_1");
    expect(secondData).toEqual(firstData);
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
    // The durable dispatch request is named after the MCP lease, so the service
    // sees the same requestId the agent gets back.
    expect(firstData.requestId).toMatch(DERIVED_REQUEST_ID);
    expect(dispatchRequestIds()).toEqual([firstData.requestId]);
    // What the service was actually asked to do, not just how often: a handler
    // that dropped or hardcoded any of these would otherwise pass every test
    // here, including the one about a version that moved on.
    expect(dispatchedWork()).toEqual({
      definitionId: 7,
      triggerNodeId: "trigger-1",
      expectedDeployedVersion: 3,
      input: { kind: "ticket", ticketKey: "PROJ-1" },
      actorLabel: "MCP client-execute",
    });
  });

  it("refuses the same key used for a different dispatch", async () => {
    serviceStartsRuns();
    const client = await connectedClient();
    await client.callTool({ name: "workflows.dispatch", arguments: DISPATCH_ARGS });

    const result = await client.callTool({
      name: "workflows.dispatch",
      arguments: {
        ...DISPATCH_ARGS,
        input: { kind: "ticket", ticketKey: "PROJ-2" },
        preflightDigest: DIGEST_PROJ2_V3,
      },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe("Idempotency key was used with a different payload");
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
    expect(await auditedErrorCodes()).toEqual(["IDEMPOTENCY_CONFLICT"]);
  });

  it("refuses a dispatch whose digest does not match its own arguments", async () => {
    serviceStartsRuns();
    const client = await connectedClient();

    const result = await client.callTool({
      name: "workflows.dispatch",
      // The digest of a different ticket: the agent is about to run something
      // other than what it was shown.
      arguments: { ...DISPATCH_ARGS, preflightDigest: DIGEST_PROJ2_V3 },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("preflightDigest does not match");
    expect(service.dispatchManualWorkflow).not.toHaveBeenCalled();
    expect(await auditedErrorCodes()).toEqual(["VALIDATION_FAILED"]);

    // Refused before the service was reached, so the key is provably unspent:
    // a typo must not cost the agent that key for a day.
    const corrected = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });
    expect(corrected.isError).not.toBe(true);
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
  });

  it("maps a deployed version that moved on to a conflict", async () => {
    service.dispatchManualWorkflow.mockRejectedValue(
      new ManualDispatchError(
        409,
        "deployment_changed",
        "The deployed workflow changed. Run the preflight again.",
      ),
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "workflows.dispatch",
      arguments: {
        ...DISPATCH_ARGS,
        expectedDeployedVersion: 4,
        preflightDigest: DIGEST_PROJ1_V4,
      },
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(
      "The deployed workflow changed. Run the preflight again.",
    );
    expect(await auditedErrorCodes()).toEqual(["CONFLICT"]);
  });

  it("refuses a member, whose role may not dispatch", async () => {
    serviceStartsRuns();
    const client = await connectedClient({ role: "member" });

    const result = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe("Access denied");
    expect(service.dispatchManualWorkflow).not.toHaveBeenCalled();
    expect(await auditedErrorCodes()).toEqual(["FORBIDDEN"]);
  });

  it("refuses a token without the dispatch scope, distinctly from a refused role", async () => {
    serviceStartsRuns();
    const client = await connectedClient({ scopes: new Set(["mcp:read"] as const) });

    const result = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe("Insufficient scope");
    expect(service.dispatchManualWorkflow).not.toHaveBeenCalled();
    expect(await auditedErrorCodes()).toEqual(["INSUFFICIENT_SCOPE"]);
  });

  it("seals the key on a dispatch queued for recovery, so a retry cannot duplicate it", async () => {
    service.dispatchManualWorkflow
      .mockResolvedValueOnce({ requestId: "queued-for-recovery", status: "recovering" })
      // Reached only if the key was wrongly handed back, and then it would mint a
      // second dispatch row for the same subject, which is the second run this
      // test exists to prevent.
      .mockImplementationOnce(async (arg: { request: { requestId: string } }) => ({
        requestId: arg.request.requestId,
        status: "started",
        runId: "wrun_duplicate",
      }));
    const client = await connectedClient();

    const first = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });
    const second = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    expect(first.isError).toBe(true);
    expect(errorText(first)).toContain("no run has started yet");
    // Says when to look for the run, and sends a dispatch that never appears to a
    // new key rather than back to this one, which cannot serve it any more.
    expect(errorText(first)).toContain("60000");
    expect(errorText(first)).toContain("NEW idempotency key");
    // The first attempt's dispatch row is alive and the recovery pass will pick
    // it up, so this key is spent: the retry is answered from the record and the
    // service is never reached a second time.
    expect(second.isError).toBe(true);
    expect(errorText(second)).toContain(
      "already carries the outcome of an earlier attempt",
    );
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
    // Not TIMEOUT, which means "lost the race with the deadline, state unknown",
    // and not CONFLICT, because nothing collided: an operator has to be able to
    // tell an accepted-but-unstarted dispatch from those two.
    expect(await auditedErrorCodes()).toEqual([
      "DEPENDENCY_UNAVAILABLE",
      "DEPENDENCY_UNAVAILABLE",
    ]);
  });

  it("does not freeze a momentary lack of capacity as this key's permanent failure", async () => {
    service.dispatchManualWorkflow
      .mockRejectedValueOnce(
        new ManualDispatchError(
          409,
          "at_capacity",
          "All workflow execution slots are currently in use.",
        ),
      )
      .mockImplementationOnce(async (arg: { request: { requestId: string } }) => ({
        requestId: arg.request.requestId,
        status: "started",
        runId: "wrun_after_capacity",
      }));
    const client = await connectedClient();

    const first = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });
    const second = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    expect(first.isError).toBe(true);
    expect(errorText(first)).toBe("All workflow execution slots are currently in use.");
    expect(second.isError).not.toBe(true);
    const requestIds = dispatchRequestIds();
    expect(requestIds).toHaveLength(2);
    // The retry has to name a new dispatch request: markManualDispatchFailed
    // buries the first requestId for good, so reusing it could never start a run.
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(requestIds[1]).toMatch(DERIVED_REQUEST_ID);
    expect(await auditedErrorCodes()).toEqual(["CONFLICT"]);
  });

  it("keeps the key when the provider could not be reached, because the ticket may already have moved", async () => {
    service.dispatchManualWorkflow.mockRejectedValue(
      new ManualDispatchError(
        502,
        "provider_unavailable",
        "Jira could not move the ticket to the AI column.",
      ),
    );
    const client = await connectedClient();

    const first = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });
    const second = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    expect(first.isError).toBe(true);
    expect(errorText(first)).toBe("Jira could not move the ticket to the AI column.");
    // This is the half of the allowlist that stops a second run: the outcome is
    // stored against the key, so the retry is answered from the record and never
    // reaches the service, which may already have moved the ticket.
    expect(second.isError).toBe(true);
    expect(errorText(second)).toContain(
      "already carries the outcome of an earlier attempt",
    );
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
  });

  it("keeps the key while a plan is awaiting a human", async () => {
    service.dispatchManualWorkflow.mockRejectedValue(
      new ManualDispatchError(
        409,
        "approval_pending",
        "This ticket has a pending or approved workflow plan.",
      ),
    );
    const client = await connectedClient();

    const first = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });
    const second = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    expect(first.isError).toBe(true);
    expect(errorText(first)).toBe("This ticket has a pending or approved workflow plan.");
    expect(second.isError).toBe(true);
    expect(errorText(second)).toContain(
      "already carries the outcome of an earlier attempt",
    );
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
  });

  it("a key reclaimed after its response lifetime dispatches again instead of replaying yesterday's run", async () => {
    serviceStartsRuns();
    const client = await connectedClient();

    const first = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });
    // Past the 24 h response lifetime, so the key is reclaimable while the
    // manual_dispatch_requests row from yesterday lives on forever.
    now = new Date("2026-08-13T13:00:00.000Z");
    const second = await client.callTool({
      name: "workflows.dispatch",
      arguments: DISPATCH_ARGS,
    });

    const firstData = (first.structuredContent as { data: { runId: string; requestId: string } })
      .data;
    const secondData = (second.structuredContent as { data: { runId: string; requestId: string } })
      .data;
    expect(firstData.runId).toBe("wrun_1");
    expect(secondData.runId).toBe("wrun_2");
    expect(secondData.requestId).not.toBe(firstData.requestId);
    expect(secondData.requestId).toMatch(DERIVED_REQUEST_ID);
    expect(service.dispatchManualWorkflow).toHaveBeenCalledTimes(2);
  });
});

/** The two shapes where the dispatch domain hands back a subject spelled
 * differently than the agent spelled it. A digest taken from the resolved shape
 * is unreproducible on the agent's side, so the pair below would fail validation
 * on every attempt, forever, with no local way to guess the canonical form. */
describe("preflight and dispatch agree on the digest", () => {
  async function preflightThenDispatch(
    subject: Record<string, unknown>,
    resolvedPreflight: Record<string, unknown>,
  ) {
    service.preflightManualDispatch.mockResolvedValue(preflightResponse(resolvedPreflight));
    serviceStartsRuns();
    const client = await connectedClient();
    const args = { ...PREFLIGHT_ARGS, input: subject };

    const preflight = await client.callTool({
      name: "workflows.dispatch_preflight",
      arguments: args,
    });
    const digest = (preflight.structuredContent as { data: { preflightDigest: string } })
      .data.preflightDigest;
    // Exactly what an agent can do: dispatch the arguments it sent, carrying the
    // digest it was handed.
    const dispatched = await client.callTool({
      name: "workflows.dispatch",
      arguments: {
        ...args,
        expectedDeployedVersion: 3,
        preflightDigest: digest,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    });
    return { digest, dispatched };
  }

  it("dispatches a ticket key the service upper-cases on its way through", async () => {
    const { digest, dispatched } = await preflightThenDispatch(
      { kind: "ticket", ticketKey: "proj-1" },
      // resolve.ts:600 upper-cases the key and service.ts:62 echoes the
      // normalized shape back in the response.
      { input: { kind: "ticket", ticketKey: "PROJ-1" } },
    );

    expect(digest).toBe(DIGEST_LOWER_PROJ1_V3);
    expect(dispatched.isError).not.toBe(true);
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
  });

  it("dispatches a pull request URL the provider echoes back in another form", async () => {
    const { digest, dispatched } = await preflightThenDispatch(
      { kind: "pull_request", url: "https://github.com/acme/app/pull/12/diffs" },
      // resolve.ts:415 returns the provider's own spelling of the URL, which the
      // agent has no way to predict locally.
      {
        input: { kind: "pull_request", url: "https://github.com/acme/app/pull/12" },
        subject: {
          kind: "pull_request",
          key: "acme/app#12",
          title: "Fix login",
          url: "https://github.com/acme/app/pull/12",
        },
      },
    );

    expect(digest).toBe(DIGEST_PR_DIFFS_V3);
    expect(dispatched.isError).not.toBe(true);
    expect(service.dispatchManualWorkflow).toHaveBeenCalledOnce();
  });
});
