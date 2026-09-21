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

const resolveUsableIntegrations = vi.fn();
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  resolveUsableIntegrations,
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

vi.mock("../../infra/vcs-config.js", () => ({
  env: { JIRA_BASE_URL: "https://acme.atlassian.net" },
}));

import { messagingSender, ticketUrlFor } from "./messaging.js";

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
    // The tracker link is core's fact, built here and rendered by the provider.
    expect(notifyForTicket.mock.calls[0]![0]).toEqual({
      key: "AWT-42",
      url: "https://acme.atlassian.net/browse/AWT-42",
    });
    expect(notifyForTicket.mock.calls[0]![2]).toMatchObject({
      handle: "1758300000.000100",
    });
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

describe("ticketUrlFor", () => {
  it("links a tracker key and refuses to guess a page for anything else", () => {
    expect(ticketUrlFor("AWT-42", "https://acme.atlassian.net")).toBe(
      "https://acme.atlassian.net/browse/AWT-42",
    );
    expect(ticketUrlFor("AWT-42", "https://acme.atlassian.net/")).toBe(
      "https://acme.atlassian.net/browse/AWT-42",
    );
    // A pull request run and a schedule occurrence have synthesized keys, and
    // /browse/<that> is always a 404.
    expect(ticketUrlFor("pr:acme/api#128", "https://acme.atlassian.net")).toBeNull();
    expect(ticketUrlFor("webhook-7f3a", "https://acme.atlassian.net")).toBeNull();
    // A deployment with no tracker configured links nowhere at all.
    expect(ticketUrlFor("AWT-42", "")).toBeNull();
  });
});
