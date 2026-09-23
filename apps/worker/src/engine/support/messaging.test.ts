/**
 * What core does when it asks for a message and the deployment cannot send one.
 *
 * Every case here ends in a run that kept going. A notification is not the
 * work, so the port answers rather than throws, and the block that asked reads
 * the answer to decide whether to branch. The sentences are asserted whole
 * because they are what a person reads in the block output, in the ticket
 * comment a workflow builds from it and in the log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingAdapter } from "@integrations/sdk";
import {
  connectedIssueTracker,
  noIssueTrackerConnected,
} from "../../test-support/issue-tracker.js";

const resolveUsableIntegrations = vi.fn();
/** Every secret the deployment knows, as the source hands it over. */
const knownSecretValues = vi.fn(async (): Promise<string[]> => []);
/**
 * The registry the runtime reads its candidates from, filled from whatever the
 * fake reader hands out, and the states the real reader would return beside
 * it: every usable integration is connected unless the test says otherwise.
 * The runtime asks the one-provider rule (`oneProviderChoiceOf`) over both.
 */
const registered = vi.hoisted(() => [] as Array<{ id: string; name: string; capabilities: string[] }>);
vi.mock("@integrations/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@integrations/registry")>()),
  integrationManifests: registered,
}));
async function readAsTheResolverWould(...args: unknown[]): Promise<unknown> {
  const result = (await resolveUsableIntegrations(...args)) as
    | { readable: boolean; usable?: Array<{ manifest: { id: string; name: string; capabilities: string[] } }>; states?: Map<string, unknown>; connectionFailures?: Map<string, unknown> }
    | undefined;
  if (!result?.readable) return result;
  const states = new Map(result.states ?? []);
  for (const entry of result.usable ?? []) {
    if (!registered.some((manifest) => manifest.id === entry.manifest.id)) registered.push(entry.manifest);
    if (!states.has(entry.manifest.id)) {
      states.set(entry.manifest.id, {
        status: "connected",
        usable: true,
        pin: { integrationId: entry.manifest.id, configFingerprint: `${entry.manifest.id}@fingerprint` },
      });
    }
  }
  return { ...result, states, connectionFailures: result.connectionFailures ?? new Map() };
}

vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  resolveUsableIntegrations: readAsTheResolverWould,
  knownSecretValues,
  // The comparison itself is the real one: a mocked pin check would prove that
  // this module calls something, not that a moved provider is refused.
  checkIntegrationPin: (
    await importOriginal<typeof import("../../services/integrations/runtime.js")>()
  ).checkIntegrationPin,
}));

const conversationFor = vi.fn(async () => ({
  handle: "1758300000.000100",
  remember: async () => {},
  forget: async () => {},
}));
vi.mock("./messaging-conversation.js", () => ({ conversationFor }));

vi.mock("../../infra/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Where a person opens the ticket comes from whichever integration serves the
// issue tracker capability, so this suite says only that one is connected and
// how it links a ticket: in a shape no tracker core has heard of, so a link
// core spelled itself could not pass. Which tracker is chosen is proved in
// `issue-tracker-runtime.test.ts`.
vi.mock("./issue-tracker-runtime.js", () =>
  connectedIssueTracker({
    ticketUrl: (key) => (key.startsWith("AWT-") ? `https://tracker.example/t/${key}` : null),
  }),
);

import { messagingSender } from "./messaging.js";

const QUERY = { channels: ["C1"], keywords: ["login"], lookbackDays: 30, maxResults: 10 };

/** One usable integration, as `resolveUsableIntegrations` hands it over. */
function provider(name: string, adapter: Partial<MessagingAdapter> | null): unknown {
  return {
    manifest: { id: name.toLowerCase(), name, capabilities: ["messaging"] },
    runtime: { capabilities: adapter === null ? {} : { messaging: () => adapter } },
    ctx: {},
  };
}

function readable(...usable: unknown[]): void {
  resolveUsableIntegrations.mockResolvedValue({ readable: true, usable, states: new Map() });
}

/** The same, plus what the deployment currently says about that connection. */
function readableWithState(name: string, fingerprint: string, adapter: unknown): void {
  const id = name.toLowerCase();
  resolveUsableIntegrations.mockResolvedValue({
    readable: true,
    usable: [provider(name, adapter as never)],
    states: new Map([
      [
        id,
        {
          integrationId: id,
          status: "connected",
          connection: "connected",
          enabled: true,
          usable: true,
          failure: null,
          pin: { integrationId: id, configFingerprint: fingerprint },
        },
      ],
    ]),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("messagingSender", () => {
  it("delivers through the one provider that serves messaging", async () => {
    const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>(async () => ({
      delivered: true,
    }));
    readable(provider("Test Chat", { notifyForTicket }));

    const delivery = await messagingSender().notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({ delivered: true });
    // The link is the tracker's, carried by core and rendered by the provider.
    expect(notifyForTicket.mock.calls[0]![0]).toEqual({
      key: "AWT-42",
      url: "https://tracker.example/t/AWT-42",
    });
    expect(notifyForTicket.mock.calls[0]![2]).toMatchObject({
      handle: "1758300000.000100",
    });
  });

  it("hands the provider each pull request with the reference and the noun its own provider uses", async () => {
    // A GitLab team read `PR ready (#12)` in the channel, `#12` being issue 12
    // there, while the run view said `MR !12`. The integration cannot ask the
    // registry, so core stamps both from the one answer before the event leaves.
    const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>(async () => ({
      delivered: true,
    }));
    readable(provider("Test Chat", { notifyForTicket }));

    await messagingSender().notifyForTicket("AWT-42", {
      kind: "pr_ready",
      usageReport: "",
      prs: [
        {
          provider: "gitlab",
          repoPath: "acme/app",
          id: 12,
          url: "https://gitlab.example/acme/app/-/merge_requests/12",
        },
        { provider: "github", repoPath: "acme/api", id: 7, url: "https://github.com/acme/api/pull/7" },
      ],
    });

    const sent = notifyForTicket.mock.calls[0]![1];
    expect(sent.kind === "pr_ready" ? sent.prs.map((pr) => pr.reference) : null).toEqual([
      "!12",
      "#7",
    ]);
    expect(sent.kind === "pr_ready" ? sent.prs.map((pr) => pr.noun) : null).toEqual(["MR", "PR"]);
  });

  // Red when: the sender hands the provider the reason workflow scope built,
  // which only the environment's secrets were taken out of. A tracing key an
  // admin stored in the dashboard, echoed by an agent, reached the channel in
  // the clear while the ticket showed it redacted.
  it("takes every secret the deployment knows out of what it sends", async () => {
    const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>(async () => ({
      delivered: true,
    }));
    readable(provider("Test Chat", { notifyForTicket }));
    knownSecretValues.mockResolvedValueOnce(["plainvalue4471tracer"]);

    await messagingSender().notifyForTicket("AWT-42", {
      kind: "failed",
      reason: "the agent printed plainvalue4471tracer and stopped",
    });

    const sent = notifyForTicket.mock.calls[0]![1] as { reason: string };
    expect(sent.reason).not.toContain("plainvalue4471tracer");
    expect(sent.reason).toContain("the agent printed");
  });

  it("sends nothing, and says so, when the secrets to redact with cannot be read", async () => {
    const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>(async () => ({
      delivered: true,
    }));
    readable(provider("Test Chat", { notifyForTicket }));
    knownSecretValues.mockRejectedValueOnce(new Error("settings unreadable"));

    const delivery = await messagingSender().notifyForTicket("AWT-42", {
      kind: "failed",
      reason: "the agent printed something",
    });

    expect(delivery).toEqual({
      delivered: false,
      reason: "the secrets to redact this notification with could not be read, so it was not sent",
    });
    expect(notifyForTicket).not.toHaveBeenCalled();
  });

  it("still sends a message about a ticket when no tracker is connected", async () => {
    // A deployment can have chat and no issue tracker since S12. The message is
    // worth sending either way: what a person needs from it is that the run
    // started, and a link to nowhere is worse than no link. So the link is
    // dropped and nothing else about the delivery changes.
    const { resolveActiveIssueTracker } = await import("./issue-tracker-runtime.js");
    const absent = noIssueTrackerConnected();
    // Once, so the deployment this file otherwise describes is unchanged for
    // every case after this one.
    vi.mocked(resolveActiveIssueTracker).mockImplementationOnce(
      absent.resolveActiveIssueTracker as never,
    );
    const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>(async () => ({
      delivered: true,
    }));
    readable(provider("Test Chat", { notifyForTicket }));

    const delivery = await messagingSender().notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({ delivered: true });
    expect(notifyForTicket.mock.calls[0]![0]).toEqual({ key: "AWT-42", url: null });
  });

  it("refuses to deliver through a provider that was reconfigured mid-run", async () => {
    // An admin edits the channel while a run is in flight. Following the edit
    // would move where that run posts with nobody told, so a caller holding a
    // pin is refused and given the reason an admin acts on.
    const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>(async () => ({
      delivered: true,
    }));
    readableWithState("Test Chat", "fp-2", { notifyForTicket });

    const delivery = await messagingSender([
      { integrationId: "test chat", configFingerprint: "fp-1" },
    ]).notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({
      delivered: false,
      reason: "Test Chat's configuration changed after this run started",
      moved: "reconfigured",
    });
    expect(notifyForTicket).not.toHaveBeenCalled();
  });

  it("delivers when the provider is the one the run pinned", async () => {
    const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>(async () => ({
      delivered: true,
    }));
    readableWithState("Test Chat", "fp-1", { notifyForTicket });

    const delivery = await messagingSender([
      { integrationId: "test chat", configFingerprint: "fp-1" },
    ]).notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({ delivered: true });
    expect(notifyForTicket).toHaveBeenCalledTimes(1);
  });

  it("says nothing is connected, and says it without naming a provider", async () => {
    // The deployment with no provider is exactly the one that cannot be told to
    // go and look at Slack.
    readable();

    const delivery = await messagingSender().notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({
      delivered: false,
      reason:
        "no messaging provider is connected on this deployment, so there was nowhere to send it",
    });
    expect(await messagingSender().searchMessages(QUERY)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("counts a failing provider, so a working one beside it does not post silently", async () => {
    const first = vi.fn(async () => ({ delivered: true }) as const);
    registered.push({ id: "other chat", name: "Other Chat", capabilities: ["messaging"] });
    resolveUsableIntegrations.mockResolvedValue({
      readable: true,
      usable: [provider("Test Chat", { notifyForTicket: first })],
      states: new Map([["other chat", { status: "failing", usable: false, failure: { message: "the token was refused" } }]]),
    });

    const delivery = await messagingSender().notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toMatchObject({
      delivered: false,
      reason: expect.stringMatching(/(Test Chat and Other Chat|Other Chat and Test Chat) both provide messaging/),
    });
    expect(first).not.toHaveBeenCalled();
  });

  it("refuses by name when two providers serve messaging and nobody chose", async () => {
    const first = vi.fn(async () => ({ delivered: true }) as const);
    const second = vi.fn(async () => ({ delivered: true }) as const);
    readable(
      provider("Test Chat", { notifyForTicket: first }),
      provider("Other Chat", { notifyForTicket: second }),
    );

    const delivery = await messagingSender().notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({
      delivered: false,
      reason:
        "Test Chat and Other Chat both provide messaging on this deployment and no active " +
        "provider is selected, so nothing was sent",
    });
    // Neither was picked: a run that posted into one of two workspaces because
    // it was first in the registry is the failure nobody can explain later.
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("does not report a database that was away as a provider nobody connected", async () => {
    resolveUsableIntegrations.mockResolvedValue({
      readable: false,
      reason: "the settings read timed out",
    });

    const delivery = await messagingSender().notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({
      delivered: false,
      reason:
        "this deployment's integration settings could not be read, so nothing was sent " +
        "(the settings read timed out)",
    });
    // And the investigation says "unavailable", not "connect a provider".
    expect(await messagingSender().searchMessages(QUERY)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("survives a provider that throws, and names it", async () => {
    const notifyForTicket = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    readable(provider("Test Chat", { notifyForTicket }));

    const delivery = await messagingSender().notifyForTicket("AWT-42", { kind: "started" });

    expect(delivery).toEqual({
      delivered: false,
      reason: "Test Chat failed to send it: socket hang up",
    });
  });

  it("reports a provider that declares messaging and ships no code for it", async () => {
    readable(provider("Test Chat", null));

    expect(await messagingSender().notifyForTicket("AWT-42", { kind: "started" })).toEqual({
      delivered: false,
      reason: "Test Chat declares messaging and ships no code for it",
    });
    expect(await messagingSender().searchMessages(QUERY)).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("asks again on every call, so disabling a provider stops the next message", async () => {
    // The kill switch an admin reaches for. A sender resolved once at process
    // start would keep posting for as long as the process lived.
    const notifyForTicket = vi.fn(async () => ({ delivered: true }) as const);
    readable(provider("Test Chat", { notifyForTicket }));
    const sender = messagingSender();
    await sender.notifyForTicket("AWT-42", { kind: "started" });

    readable();
    const after = await sender.notifyForTicket("AWT-42", { kind: "started" });

    expect(after.delivered).toBe(false);
    expect(notifyForTicket).toHaveBeenCalledTimes(1);
  });

  it("reports a provider that cannot search as unsupported rather than empty", async () => {
    // "No matches" and "this provider cannot look" lead a reader to opposite
    // conclusions about the evidence.
    readable(
      provider("Test Chat", { notifyForTicket: async () => ({ delivered: true }) }),
    );

    expect(await messagingSender().searchMessages(QUERY)).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});

beforeEach(() => {
  registered.length = 0;
});
