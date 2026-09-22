/**
 * Which tracker core works through, and what it does when it cannot have one.
 *
 * Every case here is a state that was impossible before S12, because the site,
 * the token and the project key were required environment variables and the
 * worker refused to boot without them. They are an integration's connection
 * now, so the states exist, and each one has to end in a sentence a person can
 * act on rather than in an empty string that matches no ticket on any board.
 *
 * The refusals are asserted whole: they are read in a block output, in a
 * ticket comment a run leaves behind, and on the dashboard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";

const resolveUsableIntegrations = vi.fn();
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  resolveUsableIntegrations,
  // The pin comparison itself is the real one. A mocked check would prove that
  // this module calls something, not that a tracker reconfigured mid-run is
  // refused.
  checkIntegrationPin: (
    await importOriginal<typeof import("../../services/integrations/runtime.js")>()
  ).checkIntegrationPin,
}));

// `createAdapters` is the one production caller of the resolution, and two
// cases below are about what it does with a refusal. It builds a run registry
// and reads the environment, neither of which this suite has an opinion on.
vi.mock("../../db/repositories/active-runs.js", () => ({
  createConnectedPostgresRunRegistry: () => ({ kind: "run-registry" }),
}));
vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

const {
  coreServesIssueTracker,
  issueTrackerName,
  issueTrackerWiring,
  resolveActiveIssueTracker,
  ticketSubject,
  ticketSubjects,
  trackerMoveTarget,
} = await import("./issue-tracker-runtime.js");
const { createAdapters } = await import("./adapters.js");

const NO_PROVIDER =
  "No issue tracker is connected on this deployment, so there is no ticket to work from. Connect one on the Integrations page.";

/**
 * An adapter that can answer which account it acts as, which is what every
 * ordinary case here is about to take for granted.
 */
function adapterThatKnowsItself(): Partial<IssueTrackerAdapter> {
  return { getCurrentUserAccountId: async () => "99:the-workflow-account" };
}

/** One usable integration, as `resolveUsableIntegrations` hands it over. */
function provider(
  name: string,
  options: {
    adapter?: Partial<IssueTrackerAdapter> | null;
    connection?: Record<string, unknown>;
  } = {},
): unknown {
  const adapter = "adapter" in options ? options.adapter : adapterThatKnowsItself();
  return {
    manifest: { id: name.toLowerCase(), name, capabilities: ["issue_tracker"] },
    runtime: {
      capabilities: adapter === null ? {} : { issue_tracker: () => adapter },
    },
    ctx: { connection: options.connection ?? { projectKey: "AIW", baseUrl: "https://t.example" } },
  };
}

function readable(...usable: unknown[]): void {
  resolveUsableIntegrations.mockResolvedValue({ readable: true, usable, states: new Map() });
}

function readableWithState(name: string, fingerprint: string, entry: unknown): void {
  const id = name.toLowerCase();
  resolveUsableIntegrations.mockResolvedValue({
    readable: true,
    usable: [entry],
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

describe("resolveActiveIssueTracker", () => {
  it("hands over the one integration that serves issue tracking, with its wiring", async () => {
    readable(
      provider("Test Tracker", {
        connection: {
          projectKey: "AIW",
          baseUrl: "https://acme.example",
          aiTransitionId: "21",
        },
      }),
    );

    const resolved = await resolveActiveIssueTracker();

    expect(resolved).toMatchObject({
      ok: true,
      id: "test tracker",
      name: "Test Tracker",
      wiring: { projectKey: "AIW", baseUrl: "https://acme.example", aiTransitionId: "21" },
    });
  });

  it("carries only the transition ids the connection actually set", async () => {
    // Absent means "this board reaches that column by status name". An empty
    // string carried as if it were an id makes the provider ask for a
    // transition that does not exist, halfway through moving a ticket.
    readable(
      provider("Test Tracker", {
        connection: { projectKey: "AIW", baseUrl: "https://acme.example", aiTransitionId: "  " },
      }),
    );

    const resolved = await resolveActiveIssueTracker();

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.wiring).toEqual({
      projectKey: "AIW",
      baseUrl: "https://acme.example",
    });
  });

  it("refuses, naming the capability and not a provider, when none is connected", async () => {
    // The deployment with nothing connected is exactly the one that cannot be
    // told to go and look at some provider's settings page.
    readable();

    expect(await resolveActiveIssueTracker()).toEqual({
      ok: false,
      unreadable: false,
      reason: NO_PROVIDER,
    });
  });

  it("refuses rather than picking one of two connected trackers", async () => {
    // A run that read its ticket out of whichever tracker happened to be first
    // in the registry is the failure nobody can explain afterwards.
    readable(provider("Tracker One"), provider("Tracker Two"));

    expect(await resolveActiveIssueTracker()).toEqual({
      ok: false,
      unreadable: false,
      reason:
        "Tracker One and Tracker Two both provide issue tracking on this deployment and no active provider is selected, so no ticket was read.",
    });
  });

  it("separates settings it could not read from a deployment with nothing connected", async () => {
    // The two send a person to different places, and only one of them is a page.
    resolveUsableIntegrations.mockResolvedValue({
      readable: false,
      reason: "database unavailable",
    });

    const resolved = await resolveActiveIssueTracker();

    expect(resolved).toEqual({
      ok: false,
      unreadable: true,
      reason:
        "This deployment's integration settings could not be read (database unavailable), so its issue tracker was not used.",
    });
  });

  it("refuses a tracker that declares the capability and ships no code for it", async () => {
    readable(provider("Test Tracker", { adapter: null }));

    expect(await resolveActiveIssueTracker()).toEqual({
      ok: false,
      unreadable: false,
      reason: "Test Tracker declares issue tracking and ships no code for it.",
    });
  });

  it("refuses a tracker that cannot say which account it acts as", async () => {
    // THE ONE THIS FILE EXISTS FOR. The method is optional in no sense that
    // matters: without it, every ticket move the product makes itself reads as
    // a person pulling the ticket out from under the run, so the product
    // cancels its own runs the moment it finishes them, and nothing anywhere
    // says why. The type stops an integration compiled here; this stops one
    // that was not, which the SDK explicitly allows.
    readable(
      provider("Test Tracker", {
        adapter: { listStatuses: async () => [] },
      }),
    );

    expect(await resolveActiveIssueTracker()).toEqual({
      ok: false,
      unreadable: false,
      reason:
        "Test Tracker cannot say which account it acts as, so this deployment could not tell its own ticket moves from a person's. An issue tracker has to answer that.",
    });
  });

  it("would refuse a tracker reconfigured after a run pinned it, if anything pinned one", async () => {
    // An admin re-points the connection at another project while a run is in
    // flight. Following the edit would move which project that run is working
    // in, mid-run, with nobody told.
    readableWithState("Test Tracker", "fp-2", provider("Test Tracker"));

    const resolved = await resolveActiveIssueTracker([
      { integrationId: "test tracker", configFingerprint: "fp-1" },
    ]);

    expect(resolved).toMatchObject({ ok: false, unreadable: false });
    expect(resolved.ok === false && resolved.reason).toBe(
      "The issue tracker Test Tracker moved after this run started (reconfigured). Start a new run.",
    );
  });

  it("lets a run with no recorded pins through on current settings", async () => {
    // What an absent or empty set means, stated because it is easy to read the
    // branch above as "anything unpinned is refused". A run whose row predates
    // `workflow_runs.integration_pins` carries NULL and can never recover
    // them, and refusing it would strand it rather than protect it. This is
    // the same reading the VCS side states in `vcs-runtime.ts`.
    readableWithState("Test Tracker", "fp-1", provider("Test Tracker"));

    expect(await resolveActiveIssueTracker(undefined)).toMatchObject({ ok: true });
    expect(await resolveActiveIssueTracker([])).toMatchObject({ ok: true });
  });

  it("would let a run through on the connection it pinned, if anything pinned one", async () => {
    readableWithState("Test Tracker", "fp-1", provider("Test Tracker"));

    const resolved = await resolveActiveIssueTracker([
      { integrationId: "test tracker", configFingerprint: "fp-1" },
    ]);

    expect(resolved).toMatchObject({ ok: true, name: "Test Tracker" });
  });
});

describe("what core asks of the resolution", () => {
  it("hands core a real adapter, not something that answers every name", async () => {
    // Eighteen places in core ask whether this tracker can do an optional
    // thing and take a different path when it cannot. A lazy proxy would
    // answer a function for every name, so each of those checks would start
    // saying yes and the refusal would arrive deep inside a call instead of on
    // the caller's own "this tracker cannot do that" path.
    const adapter = { ...adapterThatKnowsItself(), listStatuses: async () => [] };
    readable(provider("Test Tracker", { adapter }));

    const { issueTracker } = await createAdapters();

    expect(issueTracker.getCurrentUserAccountId).toBeTypeOf("function");
    expect((issueTracker as unknown as Record<string, unknown>).updateLabels).toBeUndefined();
  });

  it("leaves the rest of a deployment working when it has no tracker", async () => {
    // A deployment with chat and version control but no issue tracker is a
    // legitimate state now, and most callers of `createAdapters` want the run
    // registry or the sender. Refusing when the set is built would take the
    // run list, the capacity snapshot and every notification down with the
    // tracker, so the refusal waits until something reaches for the tracker.
    readable();

    const adapters = await createAdapters();

    expect(adapters.runRegistry).toBeDefined();
    expect(adapters.messaging).toBeDefined();
    expect(() => adapters.issueTracker).toThrow(NO_PROVIDER);
  });

  it("turns an unexpected throw into the same refusal, not into a dead caller", async () => {
    // The resolution answers a refusal for the states it knows about. A throw
    // is a different thing: a module that failed to load, a driver that gave
    // up. The poller builds its adapters BEFORE its first phase, so a throw
    // escaping here killed the whole tick, housekeeping included, rather than
    // the ticket half. It lands on the getter now, carrying what threw.
    resolveUsableIntegrations.mockRejectedValue(new Error("module load failed"));

    const adapters = await createAdapters();

    expect(adapters.runRegistry).toBeDefined();
    expect(adapters.messaging).toBeDefined();
    expect(() => adapters.issueTracker).toThrow("module load failed");
  });

  it("throws the refusal, in the words a person reads, when there is no tracker", async () => {
    readable();

    await expect(issueTrackerWiring()).rejects.toThrow(NO_PROVIDER);
  });

  it("answers the palette without a tracker rather than failing the page", async () => {
    readable();
    expect(await coreServesIssueTracker()).toBe(false);

    readable(provider("Test Tracker"));
    expect(await coreServesIssueTracker()).toBe(true);
  });

  it("calls a missing tracker by a name a sentence can be built around", async () => {
    // Core writes "X cancelled this run", and on a deployment with no tracker
    // the sentence still has to read like English.
    readable();
    expect(await issueTrackerName()).toBe("the issue tracker");

    readable(provider("Test Tracker"));
    expect(await issueTrackerName()).toBe("Test Tracker");
  });
});

describe("the subject key a ticket run is claimed under", () => {
  it("derives it from the id of the integration that serves the capability", async () => {
    readable(provider("Jira"));

    expect(await ticketSubject("AWT-42")).toBe("ticket:jira:AWT-42");
  });

  it("spells a whole list the same way, reading the connection once", async () => {
    // The poller asks for a subject per ticket across the entire AI column,
    // and the reconciler per active claim. Reading the tracker's connection
    // per item put a database round trip inside a loop on paths that are
    // already bounded by the invocation ceiling.
    readable(provider("Jira"));

    const keys = await ticketSubjects(["AWT-1", "AWT-2", "AWT-3"]);

    expect([...keys.values()]).toEqual([
      "ticket:jira:AWT-1",
      "ticket:jira:AWT-2",
      "ticket:jira:AWT-3",
    ]);
    expect(resolveUsableIntegrations).toHaveBeenCalledTimes(1);
  });

  it("asks nothing at all for an empty list", async () => {
    readable(provider("Jira"));

    expect(await ticketSubjects([])).toEqual(new Map());
    expect(resolveUsableIntegrations).not.toHaveBeenCalled();
  });

  it("refuses rather than claiming a run under a key nothing else will spell", async () => {
    // Dispatch, cancel, the stall watchdog, the reconciler, plan approval and
    // the MCP tools all compare this as a string. A fallback here would claim
    // a run under a key none of them derive, and the run would be invisible to
    // every one of them: not a failure, a run nobody can cancel.
    readable();

    await expect(ticketSubject("AWT-42")).rejects.toThrow(NO_PROVIDER);
  });
});

describe("the move a column name means", () => {
  it("carries the transition id this board needs, read once", async () => {
    readable(
      provider("Test Tracker", {
        connection: {
          projectKey: "AIW",
          baseUrl: "https://t.example",
          backlogTransitionId: "11",
          aiReviewTransitionId: "31",
        },
      }),
    );

    expect(await trackerMoveTarget("Backlog", "backlog")).toEqual({
      name: "Backlog",
      transitionId: "11",
    });
    expect(await trackerMoveTarget("AI Review", "aiReview")).toEqual({
      name: "AI Review",
      transitionId: "31",
    });
    // One read per move, not the two the ternary it replaced made.
    expect(resolveUsableIntegrations).toHaveBeenCalledTimes(2);
  });

  it("is the column name alone on a board that moves by status name", async () => {
    readable(provider("Test Tracker"));

    expect(await trackerMoveTarget("Backlog", "backlog")).toBe("Backlog");
  });
});
