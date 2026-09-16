import {
  workScopeWritePlanSchema,
  type WorkScope,
  type WorkScopeActor,
  type WorkScopeEntry,
} from "@shared/contracts";
import { describe, expect, it } from "vitest";
import {
  decideWorkScope,
  type WorkScopeDecisionContext,
  type WorkScopeDecisionEvent,
} from "./decide.js";

const now = "2026-09-15T10:00:00.000Z";
const earlier = "2026-09-14T09:00:00.000Z";

const run: WorkScopeActor = { kind: "run", runId: "run-2", definitionId: 40, definitionVersion: 3 };
const earlierRun: WorkScopeActor = {
  kind: "run",
  runId: "run-1",
  definitionId: 14,
  definitionVersion: 7,
};
const person: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Filip" };

const API = "github:acme/api";
const WEB = "github:acme/web";
const DOCS = "gitlab:acme/docs";
const TOOLS = "gitlab:acme/tools";
// Enabled, but the catalog holds no default branch for it.
const BROKEN = "github:acme/broken";
// Not enabled in the catalog.
const LEGACY = "github:acme/legacy";

const HELD = [
  "github:acme/held-1",
  "github:acme/held-2",
  "github:acme/held-3",
  "github:acme/held-4",
  "github:acme/held-5",
  "github:acme/held-6",
  "github:acme/held-7",
  "github:acme/held-8",
];

const NAMED = "Named in the answer to a repository question.";
const LEFT_OUT_NOT_ENABLED = "Left out of the answer to a question asked because it was not enabled.";
const LEFT_OUT_UNUSABLE = "Left out of the answer to a question asked because it could not be used.";
const DECLINED_OUTSIDE_POLICY =
  "Declined in the answer to a question asked because the trigger policy did not include it.";
const REQUESTED = "Requested by the agent.";

function context(overrides: Partial<WorkScopeDecisionContext> = {}): WorkScopeDecisionContext {
  return {
    scope: null,
    carriesRecord: true,
    catalog: { activated: true, enabledKeys: [API, WEB, DOCS, TOOLS, BROKEN], unusableKeys: [BROKEN] },
    pinnedProviders: null,
    pinnedKeys: null,
    policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
    eventRelatedKeys: [],
    attachedKeys: [],
    selectionAnswered: false,
    actor: run,
    now,
    ...overrides,
  };
}

function entry(overrides: Partial<WorkScopeEntry> & { repositoryKey: string }): WorkScopeEntry {
  return {
    state: "selected",
    origin: "inferred",
    rationale: REQUESTED,
    decidedBy: earlierRun,
    decidedAt: earlier,
    ...overrides,
  };
}

function scopeOf(...entries: WorkScopeEntry[]): WorkScope {
  return { subjectKey: "ticket:jira:AWP-211", version: 3, entries };
}

const emptyPlan = { upserts: [], deletes: [], trail: [] };

function decide(ctx: WorkScopeDecisionContext, event: WorkScopeDecisionEvent) {
  const decision = decideWorkScope(ctx, event);
  const parsed = workScopeWritePlanSchema.safeParse(decision.plan);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return decision;
}

describe("decideWorkScope decision table", () => {
  it("any run event, carriesRecord false: the attach and refusal columns, no upserts, no deletes, nothing asked", () => {
    const ctx = context({ carriesRecord: false });

    expect(decide(ctx, { kind: "requested", repositoryKeys: [API, LEGACY] })).toEqual({
      plan: {
        upserts: [],
        deletes: [],
        trail: [{ kind: "request_refused", repositoryKey: LEGACY, reason: "outside_catalog" }],
      },
      attach: [API],
      ask: [],
      refused: [{ repositoryKey: LEGACY, reason: "outside_catalog" }],
      editRejected: [],
      trailTruncated: 0,
    });
    expect(
      decide(ctx, { kind: "derived", origin: "ticket_text", repositoryKeys: [WEB], rationale: "Ticket text names web." }),
    ).toEqual({ plan: emptyPlan, attach: [WEB], ask: [], refused: [], editRejected: [], trailTruncated: 0 });
    expect(decide(ctx, { kind: "text_ambiguous", matchedKeys: [API, WEB] })).toEqual({
      plan: emptyPlan,
      attach: [],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
  });

  describe("run_started", () => {
    it("selected, reachable, candidate or exempt origin, room: attach, a person's entries first", () => {
      const decision = decide(
        context({
          policy: { candidates: { kind: "listed", repositoryKeys: [API] }, expansion: "never" },
          scope: scopeOf(
            entry({ repositoryKey: API, origin: "trigger_policy" }),
            entry({ repositoryKey: WEB, origin: "person", decidedBy: person }),
            entry({ repositoryKey: DOCS, origin: "workflow_owned_branch" }),
          ),
        }),
        { kind: "run_started" },
      );

      expect(decision).toEqual({
        plan: emptyPlan,
        attach: [WEB, DOCS, API],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("selected, reachable, candidate or exempt origin, no room: refused workspace_cap, entry kept", () => {
      const decision = decide(
        context({
          attachedKeys: HELD.slice(0, 7),
          scope: scopeOf(
            entry({ repositoryKey: WEB, origin: "trigger_policy" }),
            entry({ repositoryKey: API, origin: "person", decidedBy: person }),
          ),
        }),
        { kind: "run_started" },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [{ kind: "request_refused", repositoryKey: WEB, reason: "workspace_cap" }],
        },
        attach: [API],
        ask: [],
        refused: [{ repositoryKey: WEB, reason: "workspace_cap" }],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("selected, not usable: refused outside_catalog, entry kept, no question", () => {
      const decision = decide(
        context({
          scope: scopeOf(
            entry({ repositoryKey: BROKEN, origin: "trigger_policy" }),
            entry({ repositoryKey: LEGACY, origin: "person", decidedBy: person }),
          ),
        }),
        { kind: "run_started" },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            { kind: "request_refused", repositoryKey: LEGACY, reason: "outside_catalog" },
            { kind: "request_refused", repositoryKey: BROKEN, reason: "outside_catalog" },
          ],
        },
        attach: [],
        ask: [],
        refused: [
          { repositoryKey: LEGACY, reason: "outside_catalog" },
          { repositoryKey: BROKEN, reason: "outside_catalog" },
        ],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("selected, origin inferred: passed over in silence, while a person's entry on the same record is attached", () => {
      const inherited = decide(
        context({ scope: scopeOf(entry({ repositoryKey: API, origin: "inferred" })) }),
        { kind: "run_started" },
      );

      // No trail row either: the record already says who inferred it and when,
      // and a refusal reason for "we do not inherit a guess" would repeat in
      // every run of every subject.
      expect(inherited).toEqual({
        plan: emptyPlan,
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });

      const chosen = decide(
        context({ scope: scopeOf(entry({ repositoryKey: API, origin: "person", decidedBy: person })) }),
        { kind: "run_started" },
      );

      expect(chosen).toEqual({
        plan: emptyPlan,
        attach: [API],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("selected, origin a workflow owned branch, outside the pin: attached with no refusal", () => {
      const decision = decide(
        context({
          pinnedKeys: [WEB],
          scope: scopeOf(entry({ repositoryKey: API, origin: "workflow_owned_branch" })),
        }),
        { kind: "run_started" },
      );

      expect(decision).toEqual({
        plan: emptyPlan,
        attach: [API],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("selected, usable, not reachable: refused outside_policy, entry kept", () => {
      const decision = decide(
        context({
          pinnedProviders: ["gitlab"],
          scope: scopeOf(entry({ repositoryKey: API, origin: "person", decidedBy: person })),
        }),
        { kind: "run_started" },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [{ kind: "request_refused", repositoryKey: API, reason: "outside_policy" }],
        },
        attach: [],
        ask: [],
        refused: [{ repositoryKey: API, reason: "outside_policy" }],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("selected, reachable, not candidate, origin not exempt: refused outside_policy, entry kept", () => {
      const decision = decide(
        context({
          policy: { candidates: { kind: "listed", repositoryKeys: [WEB] }, expansion: "attach" },
          scope: scopeOf(
            entry({ repositoryKey: DOCS, origin: "trigger_policy" }),
            entry({ repositoryKey: API, origin: "ticket_text" }),
          ),
        }),
        { kind: "run_started" },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            { kind: "request_refused", repositoryKey: API, reason: "outside_policy" },
            { kind: "request_refused", repositoryKey: DOCS, reason: "outside_policy" },
          ],
        },
        attach: [],
        ask: [],
        refused: [
          { repositoryKey: API, reason: "outside_policy" },
          { repositoryKey: DOCS, reason: "outside_policy" },
        ],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("expired of either reason, reachable, candidate or expansion attach, room: attach and upsert selected inferred with replacesExpired", () => {
      const expiredApi = entry({
        repositoryKey: API,
        state: "unavailable",
        unavailableReason: "not_enabled",
        origin: "person",
        rationale: LEFT_OUT_NOT_ENABLED,
        decidedBy: person,
      });
      const expiredDocs = entry({
        repositoryKey: DOCS,
        state: "unavailable",
        unavailableReason: "unusable",
        origin: "person",
        rationale: LEFT_OUT_UNUSABLE,
        decidedBy: person,
      });
      const decision = decide(
        context({
          // DOCS is a candidate; API is not, and attaches through the expansion rule.
          policy: { candidates: { kind: "listed", repositoryKeys: [DOCS] }, expansion: "attach" },
          scope: scopeOf(expiredDocs, expiredApi),
        }),
        { kind: "run_started" },
      );

      const replacedApi = {
        repositoryKey: API,
        state: "selected",
        origin: "inferred",
        rationale:
          'Enabled in the catalog since Filip recorded it as not enabled ("Left out of the answer to a question asked because it was not enabled.").',
        decidedBy: run,
        decidedAt: now,
      };
      const replacedDocs = {
        ...replacedApi,
        repositoryKey: DOCS,
        rationale:
          'Usable in the catalog since Filip recorded it as unusable ("Left out of the answer to a question asked because it could not be used.").',
      };
      expect(decision).toEqual({
        plan: {
          upserts: [
            { entry: replacedApi, replacesExpired: true },
            { entry: replacedDocs, replacesExpired: true },
          ],
          deletes: [],
          trail: [
            { kind: "entry_written", entry: replacedApi, previousState: "unavailable" },
            { kind: "entry_written", entry: replacedDocs, previousState: "unavailable" },
          ],
        },
        attach: [API, DOCS],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("any other entry: nothing", () => {
      const decision = decide(
        context({
          policy: { candidates: { kind: "listed", repositoryKeys: [DOCS] }, expansion: "ask_once" },
          scope: scopeOf(
            entry({ repositoryKey: API, state: "excluded", origin: "person", decidedBy: person }),
            // Expired, but the policy would not have attached a request for it.
            entry({
              repositoryKey: WEB,
              state: "unavailable",
              unavailableReason: "not_enabled",
              origin: "person",
              decidedBy: person,
            }),
            // Still unusable, so not expired.
            entry({
              repositoryKey: BROKEN,
              state: "unavailable",
              unavailableReason: "unusable",
              origin: "person",
              decidedBy: person,
            }),
            // Still not enabled, so not expired.
            entry({
              repositoryKey: LEGACY,
              state: "unavailable",
              unavailableReason: "not_enabled",
              origin: "person",
              decidedBy: person,
            }),
          ),
        }),
        { kind: "run_started" },
      );

      expect(decision).toEqual({ plan: emptyPlan, attach: [], ask: [], refused: [], editRejected: [], trailTruncated: 0 });
    });
  });

  it("resumed: exactly the run_started rows, for the listed keys only", () => {
    const decision = decide(
      context({
        attachedKeys: [DOCS],
        scope: scopeOf(
          entry({ repositoryKey: WEB, origin: "inferred" }),
          entry({ repositoryKey: LEGACY, origin: "person", rationale: NAMED, decidedBy: person }),
          entry({ repositoryKey: API, origin: "person", rationale: NAMED, decidedBy: person }),
        ),
      }),
      { kind: "resumed", repositoryKeys: [LEGACY, API] },
    );

    expect(decision).toEqual({
      plan: {
        upserts: [],
        deletes: [],
        trail: [{ kind: "request_refused", repositoryKey: LEGACY, reason: "outside_catalog" }],
      },
      attach: [API],
      ask: [],
      refused: [{ repositoryKey: LEGACY, reason: "outside_catalog" }],
      editRejected: [],
      trailTruncated: 0,
    });
  });

  describe("derived", () => {
    it("key has a blocking entry: refused with excluded or unavailable", () => {
      const decision = decide(
        context({
          scope: scopeOf(
            entry({ repositoryKey: API, state: "excluded", origin: "person", decidedBy: person }),
            entry({
              repositoryKey: BROKEN,
              state: "unavailable",
              unavailableReason: "unusable",
              origin: "person",
              decidedBy: person,
            }),
            entry({
              repositoryKey: LEGACY,
              state: "unavailable",
              unavailableReason: "not_enabled",
              origin: "person",
              decidedBy: person,
            }),
          ),
        }),
        { kind: "derived", origin: "ticket_text", repositoryKeys: [API, BROKEN, LEGACY], rationale: "Ticket text names them." },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            { kind: "request_refused", repositoryKey: API, reason: "excluded" },
            { kind: "request_refused", repositoryKey: BROKEN, reason: "unavailable" },
            { kind: "request_refused", repositoryKey: LEGACY, reason: "unavailable" },
          ],
        },
        attach: [],
        ask: [],
        refused: [
          { repositoryKey: API, reason: "excluded" },
          { repositoryKey: BROKEN, reason: "unavailable" },
          { repositoryKey: LEGACY, reason: "unavailable" },
        ],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("key not usable: refused outside_catalog, a derived key never asks", () => {
      const decision = decide(context(), {
        kind: "derived",
        origin: "inferred",
        repositoryKeys: [LEGACY, BROKEN],
        rationale: "Label routing memory.",
      });

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            { kind: "request_refused", repositoryKey: LEGACY, reason: "outside_catalog" },
            { kind: "request_refused", repositoryKey: BROKEN, reason: "outside_catalog" },
          ],
        },
        attach: [],
        ask: [],
        refused: [
          { repositoryKey: LEGACY, reason: "outside_catalog" },
          { repositoryKey: BROKEN, reason: "outside_catalog" },
        ],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("key usable, outside the pin, origin the pin binds: refused outside_policy", () => {
      const decision = decide(context({ pinnedProviders: ["gitlab"] }), {
        kind: "derived",
        origin: "ticket_text",
        repositoryKeys: [API],
        rationale: "Ticket text names api.",
      });

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [{ kind: "request_refused", repositoryKey: API, reason: "outside_policy" }],
        },
        attach: [],
        ask: [],
        refused: [{ repositoryKey: API, reason: "outside_policy" }],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("key usable, outside the pin, origin a workflow owned branch: attached and recorded, with no refusal", () => {
      const decision = decide(context({ pinnedProviders: ["gitlab"] }), {
        kind: "derived",
        origin: "workflow_owned_branch",
        repositoryKeys: [API],
        rationale: "Branch ai/AWP-211.",
      });
      const branchEntry = {
        repositoryKey: API,
        state: "selected",
        origin: "workflow_owned_branch",
        rationale: "Branch ai/AWP-211.",
        decidedBy: run,
        decidedAt: now,
      };

      expect(decision).toEqual({
        plan: {
          upserts: [{ entry: branchEntry, replacesExpired: false }],
          deletes: [],
          trail: [{ kind: "entry_written", entry: branchEntry, previousState: null }],
        },
        attach: [API],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("key reachable, and candidate or exempt origin or a selected entry of exempt origin or expansion attach, room: attach and upsert selected with the event's origin", () => {
      const branch = decide(
        context({
          policy: { candidates: { kind: "listed", repositoryKeys: [API] }, expansion: "never" },
          attachedKeys: [WEB],
        }),
        {
          kind: "derived",
          origin: "workflow_owned_branch",
          repositoryKeys: [API, DOCS],
          rationale: "Branch ai/AWP-211.",
        },
      );
      const branchEntry = (repositoryKey: string) => ({
        repositoryKey,
        state: "selected",
        origin: "workflow_owned_branch",
        rationale: "Branch ai/AWP-211.",
        decidedBy: run,
        decidedAt: now,
      });
      expect(branch).toEqual({
        plan: {
          upserts: [
            { entry: branchEntry(API), replacesExpired: false },
            { entry: branchEntry(DOCS), replacesExpired: false },
          ],
          deletes: [],
          trail: [
            { kind: "entry_written", entry: branchEntry(API), previousState: null },
            { kind: "entry_written", entry: branchEntry(DOCS), previousState: null },
          ],
        },
        attach: [API, DOCS],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });

      const memory = decide(
        context({ policy: { candidates: { kind: "listed", repositoryKeys: [WEB] }, expansion: "attach" } }),
        { kind: "derived", origin: "inferred", repositoryKeys: [API], rationale: "Label routing memory: payments." },
      );
      const memoryEntry = {
        repositoryKey: API,
        state: "selected",
        origin: "inferred",
        rationale: "Label routing memory: payments.",
        decidedBy: run,
        decidedAt: now,
      };
      expect(memory).toEqual({
        plan: {
          upserts: [{ entry: memoryEntry, replacesExpired: false }],
          deletes: [],
          trail: [{ kind: "entry_written", entry: memoryEntry, previousState: null }],
        },
        attach: [API],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("as above, no room: refused workspace_cap, no entry", () => {
      const decision = decide(context({ attachedKeys: HELD }), {
        kind: "derived",
        origin: "ticket_text",
        repositoryKeys: [API],
        rationale: "Ticket text names api.",
      });

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [{ kind: "request_refused", repositoryKey: API, reason: "workspace_cap" }],
        },
        attach: [],
        ask: [],
        refused: [{ repositoryKey: API, reason: "workspace_cap" }],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("key reachable, not candidate, origin not exempt, expansion ask_once or never: refused outside_policy, a derived key never asks", () => {
      const askOnce = decide(
        context({ policy: { candidates: { kind: "listed", repositoryKeys: [WEB] }, expansion: "ask_once" } }),
        { kind: "derived", origin: "ticket_text", repositoryKeys: [API], rationale: "Ticket text names api." },
      );
      const never = decide(
        context({ policy: { candidates: { kind: "listed", repositoryKeys: [WEB] }, expansion: "never" } }),
        { kind: "derived", origin: "trigger_policy", repositoryKeys: [DOCS], rationale: "Trigger policy." },
      );

      expect(askOnce).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [{ kind: "request_refused", repositoryKey: API, reason: "outside_policy" }],
        },
        attach: [],
        ask: [],
        refused: [{ repositoryKey: API, reason: "outside_policy" }],
        editRejected: [],
        trailTruncated: 0,
      });
      expect(never).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [{ kind: "request_refused", repositoryKey: DOCS, reason: "outside_policy" }],
        },
        attach: [],
        ask: [],
        refused: [{ repositoryKey: DOCS, reason: "outside_policy" }],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("origin ticket_text or workflow_owned_branch, an entry of that origin for a key not in this event: delete it, comparing on that origin", () => {
      const textApi = entry({ repositoryKey: API, origin: "ticket_text", rationale: "Ticket text names api." });
      const decision = decide(
        context({
          scope: scopeOf(
            textApi,
            entry({ repositoryKey: DOCS, origin: "inferred" }),
            entry({ repositoryKey: WEB, origin: "workflow_owned_branch", rationale: "Branch ai/AWP-211." }),
          ),
        }),
        // More than three matches derive nothing.
        { kind: "derived", origin: "ticket_text", repositoryKeys: [], rationale: "" },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [{ repositoryKey: API, origin: "ticket_text" }],
          trail: [{ kind: "entry_removed", entry: textApi, removedBy: run }],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });
    it("a key the workspace already holds is skipped, and still counts as named for the delete rule", () => {
      const textApi = entry({ repositoryKey: API, origin: "ticket_text", rationale: "Ticket text names api." });
      const textDocs = entry({ repositoryKey: DOCS, origin: "ticket_text", rationale: "Ticket text names docs." });
      const decision = decide(
        context({
          attachedKeys: [API],
          policy: { candidates: { kind: "listed", repositoryKeys: [WEB] }, expansion: "never" },
          scope: scopeOf(textApi, textDocs),
        }),
        { kind: "derived", origin: "ticket_text", repositoryKeys: [API], rationale: "Ticket text names api." },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [{ repositoryKey: DOCS, origin: "ticket_text" }],
          trail: [{ kind: "entry_removed", entry: textDocs, removedBy: run }],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("a key held by a selected entry of exempt origin is allowed outside the candidate set", () => {
      const decision = decide(
        context({
          policy: { candidates: { kind: "listed", repositoryKeys: [WEB] }, expansion: "never" },
          scope: scopeOf(entry({ repositoryKey: API, origin: "person", rationale: NAMED, decidedBy: person })),
        }),
        { kind: "derived", origin: "ticket_text", repositoryKeys: [API], rationale: "Ticket text names api." },
      );

      expect(decision).toMatchObject({ attach: [API], refused: [] });
    });
  });

  describe("text_ambiguous", () => {
    it("carriesRecord, no selected entry of origin person, selectionAnswered false: ask every matched key with reason selection", () => {
      const decision = decide(
        context({ scope: scopeOf(entry({ repositoryKey: API, origin: "ticket_text" })) }),
        { kind: "text_ambiguous", matchedKeys: [WEB, API, DOCS] },
      );

      expect(decision).toEqual({
        plan: emptyPlan,
        attach: [],
        ask: [
          { repositoryKey: WEB, askedBecause: "selection" },
          { repositoryKey: API, askedBecause: "selection" },
          { repositoryKey: DOCS, askedBecause: "selection" },
        ],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("otherwise: nothing asked", () => {
      const event: WorkScopeDecisionEvent = { kind: "text_ambiguous", matchedKeys: [WEB, API] };
      const nothing = { plan: emptyPlan, attach: [], ask: [], refused: [], editRejected: [], trailTruncated: 0 };

      expect(
        decide(
          context({ scope: scopeOf(entry({ repositoryKey: DOCS, origin: "person", decidedBy: person })) }),
          event,
        ),
      ).toEqual(nothing);
      expect(decide(context({ selectionAnswered: true }), event)).toEqual(nothing);
      expect(decide(context({ carriesRecord: false }), event)).toEqual(nothing);
    });

    it("asks only about matched keys that are reachable and not already decided", () => {
      const decision = decide(
        context({
          pinnedProviders: ["github"],
          scope: scopeOf(
            entry({ repositoryKey: BROKEN, state: "excluded", origin: "person", decidedBy: person }),
          ),
        }),
        // DOCS is behind the provider pin, LEGACY is not enabled, BROKEN is excluded.
        { kind: "text_ambiguous", matchedKeys: [API, DOCS, LEGACY, BROKEN, WEB] },
      );

      expect(decision).toEqual({
        plan: emptyPlan,
        attach: [],
        ask: [
          { repositoryKey: API, askedBecause: "selection" },
          { repositoryKey: WEB, askedBecause: "selection" },
        ],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("asks nothing when one matched key survives the filter, because one choice is no ambiguity", () => {
      const decision = decide(
        context({
          pinnedProviders: ["github"],
          scope: scopeOf(
            entry({ repositoryKey: WEB, state: "excluded", origin: "person", decidedBy: person }),
          ),
        }),
        { kind: "text_ambiguous", matchedKeys: [API, DOCS, LEGACY, WEB] },
      );

      expect(decision).toEqual({ plan: emptyPlan, attach: [], ask: [], refused: [], editRejected: [], trailTruncated: 0 });
    });
  });

  describe("requested", () => {
    const refusedFor = (repositoryKey: string, reason: string) => ({
      plan: { upserts: [], deletes: [], trail: [{ kind: "request_refused", repositoryKey, reason }] },
      attach: [],
      ask: [],
      refused: [{ repositoryKey, reason }],
      editRejected: [],
      trailTruncated: 0,
    });
    const askedFor = (repositoryKey: string, askedBecause: string) => ({
      plan: emptyPlan,
      attach: [],
      ask: [{ repositoryKey, askedBecause }],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
    const listed = (keys: string[], expansion: "attach" | "ask_once" | "never") => ({
      candidates: { kind: "listed" as const, repositoryKeys: keys },
      expansion,
    });
    const requestApi: WorkScopeDecisionEvent = { kind: "requested", repositoryKeys: [API] };
    const requestLegacy: WorkScopeDecisionEvent = { kind: "requested", repositoryKeys: [LEGACY] };

    it("1. more than 3 keys: the first 3 are decided, the rest refused request_limit", () => {
      const decision = decide(context(), {
        kind: "requested",
        repositoryKeys: [API, WEB, DOCS, LEGACY, BROKEN],
      });

      const requested = (repositoryKey: string) => ({
        repositoryKey,
        state: "selected",
        origin: "inferred",
        rationale: REQUESTED,
        decidedBy: run,
        decidedAt: now,
      });
      expect(decision).toEqual({
        plan: {
          upserts: [
            { entry: requested(API), replacesExpired: false },
            { entry: requested(WEB), replacesExpired: false },
            { entry: requested(DOCS), replacesExpired: false },
          ],
          deletes: [],
          trail: [
            { kind: "entry_written", entry: requested(API), previousState: null },
            { kind: "entry_written", entry: requested(WEB), previousState: null },
            { kind: "entry_written", entry: requested(DOCS), previousState: null },
            { kind: "request_refused", repositoryKey: LEGACY, reason: "request_limit" },
            { kind: "request_refused", repositoryKey: BROKEN, reason: "request_limit" },
          ],
        },
        attach: [API, WEB, DOCS],
        ask: [],
        refused: [
          { repositoryKey: LEGACY, reason: "request_limit" },
          { repositoryKey: BROKEN, reason: "request_limit" },
        ],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("2. key already attached: nothing", () => {
      expect(decide(context({ attachedKeys: [API] }), requestApi)).toEqual({
        plan: emptyPlan,
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("3. key not in providers: refused outside_policy, never a question", () => {
      const decision = decide(
        context({
          pinnedProviders: ["gitlab"],
          policy: listed([DOCS], "ask_once"),
          scope: scopeOf(entry({ repositoryKey: API, state: "excluded", origin: "person", decidedBy: person })),
        }),
        requestApi,
      );

      expect(decision).toEqual(refusedFor(API, "outside_policy"));
    });

    it("4. key has a blocking entry: refused with excluded or unavailable, never a question", () => {
      const decision = decide(
        context({
          policy: listed([WEB], "ask_once"),
          scope: scopeOf(
            entry({ repositoryKey: API, state: "excluded", origin: "person", decidedBy: person }),
            entry({
              repositoryKey: LEGACY,
              state: "unavailable",
              unavailableReason: "not_enabled",
              origin: "person",
              decidedBy: person,
            }),
          ),
        }),
        { kind: "requested", repositoryKeys: [API, LEGACY] },
      );

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            { kind: "request_refused", repositoryKey: API, reason: "excluded" },
            { kind: "request_refused", repositoryKey: LEGACY, reason: "unavailable" },
          ],
        },
        attach: [],
        ask: [],
        refused: [
          { repositoryKey: API, reason: "excluded" },
          { repositoryKey: LEGACY, reason: "unavailable" },
        ],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("5. key not usable, allowed if usable, no entry, carriesRecord, expansion not never: ask unusable when enabled, otherwise not_enabled", () => {
      const decision = decide(context(), { kind: "requested", repositoryKeys: [BROKEN, LEGACY] });

      expect(decision).toEqual({
        plan: emptyPlan,
        attach: [],
        ask: [
          { repositoryKey: BROKEN, askedBecause: "unusable" },
          { repositoryKey: LEGACY, askedBecause: "not_enabled" },
        ],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("6. key not usable, allowed if usable, otherwise: refused outside_catalog", () => {
      expect(decide(context({ policy: listed([LEGACY], "never") }), requestLegacy)).toEqual(
        refusedFor(LEGACY, "outside_catalog"),
      );
      expect(decide(context({ carriesRecord: false }), requestLegacy)).toEqual(
        refusedFor(LEGACY, "outside_catalog"),
      );
      expect(
        decide(
          context({
            policy: listed([WEB], "ask_once"),
            scope: scopeOf(entry({ repositoryKey: LEGACY, origin: "person", rationale: NAMED, decidedBy: person })),
          }),
          requestLegacy,
        ),
      ).toEqual(refusedFor(LEGACY, "outside_catalog"));
    });

    it("7. key not usable, not allowed if usable, ask_once, carriesRecord, room, no entry or a selected entry of non-exempt origin: ask outside_policy", () => {
      expect(decide(context({ policy: listed([WEB], "ask_once") }), requestLegacy)).toEqual(
        askedFor(LEGACY, "outside_policy"),
      );
      expect(
        decide(
          context({
            policy: listed([WEB], "ask_once"),
            scope: scopeOf(entry({ repositoryKey: LEGACY, origin: "inferred" })),
          }),
          requestLegacy,
        ),
      ).toEqual(askedFor(LEGACY, "outside_policy"));
    });

    it("8. key not usable, not allowed if usable, otherwise: refused outside_policy", () => {
      expect(decide(context({ policy: listed([WEB], "never") }), requestLegacy)).toEqual(
        refusedFor(LEGACY, "outside_policy"),
      );
      expect(
        decide(context({ policy: listed([WEB], "ask_once"), attachedKeys: HELD }), requestLegacy),
      ).toEqual(refusedFor(LEGACY, "outside_policy"));
      expect(
        decide(context({ policy: listed([WEB], "ask_once"), carriesRecord: false }), requestLegacy),
      ).toEqual(refusedFor(LEGACY, "outside_policy"));
    });

    it("under enabled_catalog a disabled key asks not_enabled whether the expansion attaches or asks once, and is refused outside_catalog when it never expands", () => {
      const enabledCatalog = (expansion: "attach" | "ask_once" | "never") => ({
        candidates: { kind: "enabled_catalog" as const },
        expansion,
      });

      expect(decide(context({ policy: enabledCatalog("attach") }), requestLegacy)).toEqual(
        askedFor(LEGACY, "not_enabled"),
      );
      expect(decide(context({ policy: enabledCatalog("ask_once") }), requestLegacy)).toEqual(
        askedFor(LEGACY, "not_enabled"),
      );
      expect(decide(context({ policy: enabledCatalog("never") }), requestLegacy)).toEqual(
        refusedFor(LEGACY, "outside_catalog"),
      );
    });

    it("9. key usable, not allowed, ask_once, carriesRecord, room, no entry or a selected entry of non-exempt origin: ask outside_policy", () => {
      const policy = listed([WEB], "ask_once");

      expect(decide(context({ policy }), requestApi)).toEqual(askedFor(API, "outside_policy"));
      expect(
        decide(context({ policy, scope: scopeOf(entry({ repositoryKey: DOCS, origin: "ticket_text" })) }), {
          kind: "requested",
          repositoryKeys: [DOCS],
        }),
      ).toEqual(askedFor(DOCS, "outside_policy"));
    });

    it("10. key usable, not allowed, otherwise: refused workspace_cap when room is the only obstacle, otherwise outside_policy", () => {
      expect(decide(context({ policy: listed([WEB], "ask_once"), attachedKeys: HELD }), requestApi)).toEqual(
        refusedFor(API, "workspace_cap"),
      );
      expect(decide(context({ policy: listed([WEB], "never") }), requestApi)).toEqual(
        refusedFor(API, "outside_policy"),
      );
      expect(decide(context({ policy: listed([WEB], "never"), attachedKeys: HELD }), requestApi)).toEqual(
        refusedFor(API, "outside_policy"),
      );
      expect(decide(context({ policy: listed([WEB], "ask_once"), carriesRecord: false }), requestApi)).toEqual(
        refusedFor(API, "outside_policy"),
      );
    });

    it("11. key usable, allowed, room: attach, upsert selected inferred, with replacesExpired over an expired entry", () => {
      const requestedApi = {
        repositoryKey: API,
        state: "selected",
        origin: "inferred",
        rationale: REQUESTED,
        decidedBy: run,
        decidedAt: now,
      };
      const attached = {
        plan: {
          upserts: [{ entry: requestedApi, replacesExpired: false }],
          deletes: [],
          trail: [{ kind: "entry_written", entry: requestedApi, previousState: null }],
        },
        attach: [API],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      };

      expect(decide(context({ policy: listed([API], "never") }), requestApi)).toEqual(attached);
      expect(decide(context({ policy: listed([WEB], "attach") }), requestApi)).toEqual(attached);
      // Allowed by a person's selection alone, outside the candidate set.
      expect(
        decide(
          context({
            policy: listed([WEB], "never"),
            scope: scopeOf(entry({ repositoryKey: API, origin: "person", rationale: NAMED, decidedBy: person })),
          }),
          requestApi,
        ),
      ).toMatchObject({ attach: [API], ask: [], refused: [] });
      expect(
        decide(
          context({
            policy: listed([API], "never"),
            scope: scopeOf(
              entry({
                repositoryKey: API,
                state: "unavailable",
                unavailableReason: "unusable",
                origin: "person",
                rationale: LEFT_OUT_UNUSABLE,
                decidedBy: person,
              }),
            ),
          }),
          requestApi,
        ),
      ).toEqual({
        plan: {
          upserts: [{ entry: requestedApi, replacesExpired: true }],
          deletes: [],
          trail: [{ kind: "entry_written", entry: requestedApi, previousState: "unavailable" }],
        },
        attach: [API],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("12. key usable, allowed, no room: refused workspace_cap, no entry", () => {
      expect(decide(context({ attachedKeys: HELD }), requestApi)).toEqual(refusedFor(API, "workspace_cap"));
    });

    it("a related key the catalog does not enable asks not_enabled, not outside_policy", () => {
      expect(
        decide(
          context({
            policy: { candidates: { kind: "event_repository_and_related" }, expansion: "ask_once" },
            eventRelatedKeys: [LEGACY],
          }),
          requestLegacy,
        ),
      ).toEqual(askedFor(LEGACY, "not_enabled"));
    });
  });

  describe("answered", () => {
    it("carriesRecord false: programming error, thrown", () => {
      expect(() =>
        decideWorkScope(context({ carriesRecord: false, actor: person, policy: null }), {
          kind: "answered",
          clarificationId: "clar-7",
          asked: [{ repositoryKey: LEGACY, askedBecause: "not_enabled" }],
          answer: { kind: "none" },
        }),
      ).toThrow();
    });

    it("answer unrecognised: no entries, question_answered only", () => {
      const decision = decide(context({ actor: person, policy: null }), {
        kind: "answered",
        clarificationId: "clar-7",
        asked: [{ repositoryKey: LEGACY, askedBecause: "not_enabled" }],
        answer: { kind: "unrecognised" },
      });

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            {
              kind: "question_answered",
              clarificationId: "clar-7",
              answer: { kind: "unrecognised" },
              answeredBy: person,
            },
          ],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("answer none or repositories, an asked key the answer does not name: recorded by the reason it was asked", () => {
      const decision = decide(context({ actor: person, policy: null }), {
        kind: "answered",
        clarificationId: "clar-7",
        asked: [
          { repositoryKey: LEGACY, askedBecause: "not_enabled" },
          { repositoryKey: BROKEN, askedBecause: "unusable" },
          { repositoryKey: API, askedBecause: "outside_policy" },
          { repositoryKey: WEB, askedBecause: "selection" },
        ],
        answer: { kind: "none" },
      });

      const legacy = {
        repositoryKey: LEGACY,
        state: "unavailable",
        unavailableReason: "not_enabled",
        origin: "person",
        rationale: LEFT_OUT_NOT_ENABLED,
        decidedBy: person,
        decidedAt: now,
      };
      const broken = {
        repositoryKey: BROKEN,
        state: "unavailable",
        unavailableReason: "unusable",
        origin: "person",
        rationale: LEFT_OUT_UNUSABLE,
        decidedBy: person,
        decidedAt: now,
      };
      const api = {
        repositoryKey: API,
        state: "excluded",
        origin: "person",
        rationale: DECLINED_OUTSIDE_POLICY,
        decidedBy: person,
        decidedAt: now,
      };
      expect(decision).toEqual({
        plan: {
          upserts: [
            { entry: legacy, replacesExpired: false },
            { entry: broken, replacesExpired: false },
            { entry: api, replacesExpired: false },
          ],
          deletes: [],
          trail: [
            { kind: "question_answered", clarificationId: "clar-7", answer: { kind: "none" }, answeredBy: person },
            { kind: "entry_written", entry: legacy, previousState: null, clarificationId: "clar-7" },
            { kind: "entry_written", entry: broken, previousState: null, clarificationId: "clar-7" },
            { kind: "entry_written", entry: api, previousState: null, clarificationId: "clar-7" },
          ],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("a named key, enabled or not: upsert selected person", () => {
      const decision = decide(context({ actor: person, policy: null }), {
        kind: "answered",
        clarificationId: "clar-8",
        asked: [{ repositoryKey: LEGACY, askedBecause: "not_enabled" }],
        answer: { kind: "repositories", repositoryKeys: [LEGACY, DOCS] },
      });

      const named = (repositoryKey: string) => ({
        repositoryKey,
        state: "selected",
        origin: "person",
        rationale: NAMED,
        decidedBy: person,
        decidedAt: now,
      });
      expect(decision).toEqual({
        plan: {
          upserts: [
            { entry: named(LEGACY), replacesExpired: false },
            { entry: named(DOCS), replacesExpired: false },
          ],
          deletes: [],
          trail: [
            {
              kind: "question_answered",
              clarificationId: "clar-8",
              answer: { kind: "repositories", repositoryKeys: [LEGACY, DOCS] },
              answeredBy: person,
            },
            { kind: "entry_written", entry: named(LEGACY), previousState: null, clarificationId: "clar-8" },
            { kind: "entry_written", entry: named(DOCS), previousState: null, clarificationId: "clar-8" },
          ],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });
  });

  describe("edited", () => {
    const eight = [
      "github:acme/s-1",
      "github:acme/s-2",
      "github:acme/s-3",
      "github:acme/s-4",
      "github:acme/s-5",
      "github:acme/s-6",
      "github:acme/s-7",
      "github:acme/s-8",
    ];
    const editContext = (keys: string[]) =>
      context({
        actor: person,
        policy: null,
        attachedKeys: null,
        catalog: { activated: true, enabledKeys: [API, WEB, DOCS, ...keys], unusableKeys: [] },
        scope: scopeOf(...keys.map((repositoryKey) => entry({ repositoryKey, origin: "ticket_text" }))),
      });

    it("carriesRecord false: programming error, thrown", () => {
      expect(() =>
        decideWorkScope(context({ carriesRecord: false, actor: person, policy: null }), {
          kind: "edited",
          changes: [{ repositoryKey: API, action: "exclude" }],
        }),
      ).toThrow();
    });

    it("the whole edit: decided on the set after every change, one rejected change rejects the edit and the plan is empty", () => {
      const decision = decide(editContext(eight), {
        kind: "edited",
        changes: [
          { repositoryKey: WEB, action: "exclude" },
          { repositoryKey: LEGACY, action: "select" },
        ],
      });

      expect(decision).toEqual({
        plan: emptyPlan,
        attach: [],
        ask: [],
        refused: [],
        editRejected: [{ repositoryKey: LEGACY, reason: "not_enabled" }],
        trailTruncated: 0,
      });
    });

    it("select: enabled upserts selected person, not enabled is rejected not_enabled", () => {
      const accepted = decide(editContext([]), {
        kind: "edited",
        changes: [{ repositoryKey: API, action: "select", rationale: "Needed for the refund endpoint." }],
      });
      const selectedApi = {
        repositoryKey: API,
        state: "selected",
        origin: "person",
        rationale: "Needed for the refund endpoint.",
        decidedBy: person,
        decidedAt: now,
      };
      expect(accepted).toEqual({
        plan: {
          upserts: [{ entry: selectedApi, replacesExpired: false }],
          deletes: [],
          trail: [{ kind: "entry_written", entry: selectedApi, previousState: null }],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });

      expect(
        decide(editContext([]), { kind: "edited", changes: [{ repositoryKey: LEGACY, action: "select" }] }),
      ).toEqual({
        plan: emptyPlan,
        attach: [],
        ask: [],
        refused: [],
        editRejected: [{ repositoryKey: LEGACY, reason: "not_enabled" }],
        trailTruncated: 0,
      });
    });

    it("exclude: upsert excluded person", () => {
      const decision = decide(editContext([API]), {
        kind: "edited",
        changes: [{ repositoryKey: API, action: "exclude", rationale: "Out of scope for this ticket." }],
      });

      const excludedApi = {
        repositoryKey: API,
        state: "excluded",
        origin: "person",
        rationale: "Out of scope for this ticket.",
        decidedBy: person,
        decidedAt: now,
      };
      expect(decision).toEqual({
        plan: {
          upserts: [{ entry: excludedApi, replacesExpired: false }],
          deletes: [],
          trail: [{ kind: "entry_written", entry: excludedApi, previousState: "selected" }],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("remove: delete comparing on the current entry's origin, no entry: nothing", () => {
      const decision = decide(editContext([API]), {
        kind: "edited",
        changes: [
          { repositoryKey: API, action: "remove" },
          { repositoryKey: WEB, action: "remove" },
        ],
      });

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [{ repositoryKey: API, origin: "ticket_text" }],
          trail: [
            {
              kind: "entry_removed",
              entry: entry({ repositoryKey: API, origin: "ticket_text" }),
              removedBy: person,
            },
          ],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("a remove then a select of one repository is the select alone", () => {
      const decision = decide(editContext([API]), {
        kind: "edited",
        changes: [
          { repositoryKey: API, action: "remove" },
          { repositoryKey: API, action: "select", rationale: "On second thought." },
        ],
      });

      const selectedApi = {
        repositoryKey: API,
        state: "selected",
        origin: "person",
        rationale: "On second thought.",
        decidedBy: person,
        decidedAt: now,
      };
      expect(decision).toEqual({
        plan: {
          upserts: [{ entry: selectedApi, replacesExpired: false }],
          deletes: [],
          trail: [{ kind: "entry_written", entry: selectedApi, previousState: "selected" }],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("a select then a remove of one repository is the remove alone", () => {
      const decision = decide(editContext([API]), {
        kind: "edited",
        changes: [
          { repositoryKey: API, action: "select", rationale: "On second thought." },
          { repositoryKey: API, action: "remove" },
        ],
      });

      expect(decision).toEqual({
        plan: {
          upserts: [],
          deletes: [{ repositoryKey: API, origin: "ticket_text" }],
          trail: [
            {
              kind: "entry_removed",
              entry: entry({ repositoryKey: API, origin: "ticket_text" }),
              removedBy: person,
            },
          ],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });

    it("two repositories swapping places keep the last change of each", () => {
      const decision = decide(editContext([API, WEB]), {
        kind: "edited",
        changes: [
          { repositoryKey: API, action: "remove" },
          { repositoryKey: WEB, action: "select", rationale: "The frontend after all." },
          { repositoryKey: API, action: "select", rationale: "The API after all." },
          { repositoryKey: WEB, action: "remove" },
        ],
      });

      const selectedApi = {
        repositoryKey: API,
        state: "selected",
        origin: "person",
        rationale: "The API after all.",
        decidedBy: person,
        decidedAt: now,
      };
      expect(decision).toEqual({
        plan: {
          upserts: [{ entry: selectedApi, replacesExpired: false }],
          deletes: [{ repositoryKey: WEB, origin: "ticket_text" }],
          trail: [
            { kind: "entry_written", entry: selectedApi, previousState: "selected" },
            {
              kind: "entry_removed",
              entry: entry({ repositoryKey: WEB, origin: "ticket_text" }),
              removedBy: person,
            },
          ],
        },
        attach: [],
        ask: [],
        refused: [],
        editRejected: [],
        trailTruncated: 0,
      });
    });
  });
});

describe("decideWorkScope vocabulary", () => {
  it("plans no upsert when state, reason, origin and rationale equal the stored entry", () => {
    const decision = decide(
      context({
        scope: scopeOf(entry({ repositoryKey: API, origin: "ticket_text", rationale: "Ticket text names api." })),
      }),
      { kind: "derived", origin: "ticket_text", repositoryKeys: [API], rationale: "Ticket text names api." },
    );

    expect(decision).toEqual({ plan: emptyPlan, attach: [API], ask: [], refused: [], editRejected: [], trailTruncated: 0 });
  });

  it("plans a derived upsert over a person's entry and leaves precedence to the store", () => {
    const decision = decide(
      context({
        scope: scopeOf(entry({ repositoryKey: API, origin: "person", rationale: NAMED, decidedBy: person })),
      }),
      { kind: "derived", origin: "ticket_text", repositoryKeys: [API], rationale: "Ticket text names api." },
    );

    const textApi = {
      repositoryKey: API,
      state: "selected",
      origin: "ticket_text",
      rationale: "Ticket text names api.",
      decidedBy: run,
      decidedAt: now,
    };
    expect(decision.plan).toEqual({
      upserts: [{ entry: textApi, replacesExpired: false }],
      deletes: [],
      trail: [{ kind: "entry_written", entry: textApi, previousState: "selected" }],
    });
    expect(decision.attach).toEqual([API]);
  });

  it("sets replacesExpired on a derived selection over an expired entry", () => {
    const decision = decide(
      context({
        scope: scopeOf(
          entry({
            repositoryKey: API,
            state: "unavailable",
            unavailableReason: "not_enabled",
            origin: "person",
            rationale: LEFT_OUT_NOT_ENABLED,
            decidedBy: person,
          }),
        ),
      }),
      { kind: "derived", origin: "ticket_text", repositoryKeys: [API], rationale: "Ticket text names api." },
    );

    expect(decision.plan.upserts).toEqual([
      {
        entry: {
          repositoryKey: API,
          state: "selected",
          origin: "ticket_text",
          rationale: "Ticket text names api.",
          decidedBy: run,
          decidedAt: now,
        },
        replacesExpired: true,
      },
    ]);
    expect(decision.attach).toEqual([API]);
  });

  it("does not attach at run start or resume a key the workspace already holds", () => {
    const ctx = context({
      attachedKeys: [API],
      scope: scopeOf(entry({ repositoryKey: API, origin: "person", rationale: NAMED, decidedBy: person })),
    });
    const nothing = { plan: emptyPlan, attach: [], ask: [], refused: [], editRejected: [], trailTruncated: 0 };

    expect(decide(ctx, { kind: "run_started" })).toEqual(nothing);
    expect(decide(ctx, { kind: "resumed", repositoryKeys: [API] })).toEqual(nothing);
  });

  it("candidates of event_repository_and_related are the event's related keys", () => {
    const ctx = context({
      policy: { candidates: { kind: "event_repository_and_related" }, expansion: "never" },
      eventRelatedKeys: [WEB],
    });

    expect(decide(ctx, { kind: "requested", repositoryKeys: [WEB, API] })).toMatchObject({
      attach: [WEB],
      refused: [{ repositoryKey: API, reason: "outside_policy" }],
    });
  });
});

describe("decideWorkScope sequences", () => {
  const legacyLeftOut = entry({
    repositoryKey: LEGACY,
    state: "unavailable",
    unavailableReason: "not_enabled",
    origin: "person",
    rationale: LEFT_OUT_NOT_ENABLED,
    decidedBy: person,
    decidedAt: now,
  });
  const catalogWithLegacy = {
    activated: true,
    enabledKeys: [API, WEB, DOCS, TOOLS, BROKEN, LEGACY],
    unusableKeys: [BROKEN],
  };

  it("a) a not_enabled question answered none, then a later run requests the same key: refused unavailable, nothing asked", () => {
    const answered = decide(context({ actor: person, policy: null }), {
      kind: "answered",
      clarificationId: "clar-1",
      asked: [{ repositoryKey: LEGACY, askedBecause: "not_enabled" }],
      answer: { kind: "none" },
    });
    expect(answered.plan.upserts).toEqual([
      {
        entry: {
          repositoryKey: LEGACY,
          state: "unavailable",
          unavailableReason: "not_enabled",
          origin: "person",
          rationale: LEFT_OUT_NOT_ENABLED,
          decidedBy: person,
          decidedAt: now,
        },
        replacesExpired: false,
      },
    ]);

    const later = decide(
      context({
        scope: scopeOf(legacyLeftOut),
        policy: { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
      }),
      { kind: "requested", repositoryKeys: [LEGACY] },
    );
    expect(later.refused).toEqual([{ repositoryKey: LEGACY, reason: "unavailable" }]);
    expect(later.ask).toEqual([]);
  });

  it("b) a not_enabled answer none, then the key is enabled: run_started attaches it under a candidate policy; under a narrower ask_once policy a disabled key is asked outside_policy once and never again", () => {
    const attachPolicy = decide(context({ scope: scopeOf(legacyLeftOut), catalog: catalogWithLegacy }), {
      kind: "run_started",
    });
    const replaced = {
      repositoryKey: LEGACY,
      state: "selected",
      origin: "inferred",
      rationale:
        'Enabled in the catalog since Filip recorded it as not enabled ("Left out of the answer to a question asked because it was not enabled.").',
      decidedBy: run,
      decidedAt: now,
    };
    expect(attachPolicy).toEqual({
      plan: {
        upserts: [{ entry: replaced, replacesExpired: true }],
        deletes: [],
        trail: [{ kind: "entry_written", entry: replaced, previousState: "unavailable" }],
      },
      attach: [LEGACY],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });

    const narrow = { candidates: { kind: "listed" as const, repositoryKeys: [API] }, expansion: "ask_once" as const };
    expect(decide(context({ policy: narrow }), { kind: "requested", repositoryKeys: [LEGACY] })).toEqual({
      plan: emptyPlan,
      attach: [],
      ask: [{ repositoryKey: LEGACY, askedBecause: "outside_policy" }],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });

    const answered = decide(context({ actor: person, policy: null }), {
      kind: "answered",
      clarificationId: "clar-5",
      asked: [{ repositoryKey: LEGACY, askedBecause: "outside_policy" }],
      answer: { kind: "none" },
    });
    const declined = {
      repositoryKey: LEGACY,
      state: "excluded",
      origin: "person",
      rationale: DECLINED_OUTSIDE_POLICY,
      decidedBy: person,
      decidedAt: now,
    };
    expect(answered.plan.upserts).toEqual([{ entry: declined, replacesExpired: false }]);

    const enabled = context({
      policy: narrow,
      catalog: catalogWithLegacy,
      scope: scopeOf(declined as WorkScopeEntry),
    });
    expect(decide(enabled, { kind: "run_started" })).toEqual({
      plan: emptyPlan,
      attach: [],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
    expect(decide(enabled, { kind: "requested", repositoryKeys: [LEGACY] })).toMatchObject({
      attach: [],
      ask: [],
      refused: [{ repositoryKey: LEGACY, reason: "excluded" }],
    });
  });

  it("c) on a bridge catalog the entry never expires and a request is refused unavailable", () => {
    const bridge = context({
      scope: scopeOf(legacyLeftOut),
      catalog: { ...catalogWithLegacy, activated: false },
    });

    expect(decide(bridge, { kind: "run_started" })).toEqual({
      plan: emptyPlan,
      attach: [],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
    expect(decide(bridge, { kind: "requested", repositoryKeys: [LEGACY] })).toMatchObject({
      attach: [],
      ask: [],
      refused: [{ repositoryKey: LEGACY, reason: "unavailable" }],
    });
  });

  it("d) a person excludes a key, then the ticket text names it: refused excluded", () => {
    const edit = decide(context({ actor: person, policy: null, attachedKeys: null }), {
      kind: "edited",
      changes: [{ repositoryKey: API, action: "exclude" }],
    });
    expect(edit.plan.upserts).toEqual([
      {
        entry: { repositoryKey: API, state: "excluded", origin: "person", rationale: "", decidedBy: person, decidedAt: now },
        replacesExpired: false,
      },
    ]);

    const later = decide(
      context({
        scope: scopeOf(entry({ repositoryKey: API, state: "excluded", origin: "person", rationale: "", decidedBy: person })),
      }),
      { kind: "derived", origin: "ticket_text", repositoryKeys: [API], rationale: "Ticket text names api." },
    );
    expect(later).toEqual({
      plan: {
        upserts: [],
        deletes: [],
        trail: [{ kind: "request_refused", repositoryKey: API, reason: "excluded" }],
      },
      attach: [],
      ask: [],
      refused: [{ repositoryKey: API, reason: "excluded" }],
      editRejected: [],
      trailTruncated: 0,
    });
  });

  it("e) the ticket text named A, a corrected ticket names B: upsert B, delete A comparing on ticket_text", () => {
    const first = decide(context(), {
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: [API],
      rationale: "Ticket text names api.",
    });
    const textApi = {
      repositoryKey: API,
      state: "selected",
      origin: "ticket_text",
      rationale: "Ticket text names api.",
      decidedBy: run,
      decidedAt: now,
    };
    expect(first.plan.upserts).toEqual([{ entry: textApi, replacesExpired: false }]);

    const secondRun: WorkScopeActor = { kind: "run", runId: "run-3", definitionId: 40, definitionVersion: 3 };
    const corrected = decide(
      context({ actor: secondRun, scope: scopeOf(textApi as WorkScopeEntry), attachedKeys: [API] }),
      { kind: "derived", origin: "ticket_text", repositoryKeys: [WEB], rationale: "Ticket text names web." },
    );
    const textWeb = {
      repositoryKey: WEB,
      state: "selected",
      origin: "ticket_text",
      rationale: "Ticket text names web.",
      decidedBy: secondRun,
      decidedAt: now,
    };
    expect(corrected).toEqual({
      plan: {
        upserts: [{ entry: textWeb, replacesExpired: false }],
        deletes: [{ repositoryKey: API, origin: "ticket_text" }],
        trail: [
          { kind: "entry_written", entry: textWeb, previousState: null },
          { kind: "entry_removed", entry: textApi, removedBy: secondRun },
        ],
      },
      attach: [WEB],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
  });

  it("f) an inherited inferred entry is attached under no policy, while a person's and a workflow owned branch's survive a narrow one", () => {
    const listedWeb = { candidates: { kind: "listed" as const, repositoryKeys: [WEB] }, expansion: "attach" as const };
    const everything = {
      candidates: { kind: "enabled_catalog" as const },
      expansion: "attach" as const,
    };

    // An inference is not inherited, so the policy never gets to speak about
    // it: no attach under the narrow policy, and none under the widest one
    // either, where a candidate of any other origin would have been taken.
    for (const policy of [listedWeb, everything]) {
      expect(
        decide(context({ policy, scope: scopeOf(entry({ repositoryKey: API, origin: "inferred" })) }), {
          kind: "run_started",
        }),
      ).toMatchObject({ attach: [], refused: [] });
    }
    expect(
      decide(
        context({ policy: listedWeb, scope: scopeOf(entry({ repositoryKey: API, origin: "person", decidedBy: person })) }),
        { kind: "run_started" },
      ),
    ).toMatchObject({ attach: [API], refused: [] });
    expect(
      decide(
        context({ policy: listedWeb, scope: scopeOf(entry({ repositoryKey: API, origin: "workflow_owned_branch" })) }),
        { kind: "run_started" },
      ),
    ).toMatchObject({ attach: [API], refused: [] });
  });

  it("g) a record with eight selected entries of which two attach still takes a request for a usable candidate", () => {
    const scope = scopeOf(
      entry({ repositoryKey: API, origin: "person", decidedBy: person }),
      entry({ repositoryKey: WEB, origin: "ticket_text" }),
      entry({ repositoryKey: DOCS, origin: "trigger_policy" }),
      entry({ repositoryKey: LEGACY, origin: "person", decidedBy: person }),
      entry({ repositoryKey: BROKEN, origin: "trigger_policy" }),
      entry({ repositoryKey: "github:acme/old-1", origin: "trigger_policy" }),
      entry({ repositoryKey: "github:acme/old-2", origin: "trigger_policy" }),
      entry({ repositoryKey: "github:acme/old-3", origin: "trigger_policy" }),
    );
    const policy = { candidates: { kind: "listed" as const, repositoryKeys: [WEB, TOOLS] }, expansion: "never" as const };

    expect(decide(context({ scope, policy }), { kind: "run_started" })).toMatchObject({
      attach: [API, WEB],
      refused: [
        { repositoryKey: LEGACY, reason: "outside_catalog" },
        { repositoryKey: BROKEN, reason: "outside_catalog" },
        { repositoryKey: "github:acme/old-1", reason: "outside_catalog" },
        { repositoryKey: "github:acme/old-2", reason: "outside_catalog" },
        { repositoryKey: "github:acme/old-3", reason: "outside_catalog" },
        { repositoryKey: DOCS, reason: "outside_policy" },
      ],
    });

    const request = decide(context({ scope, policy, attachedKeys: [API, WEB] }), {
      kind: "requested",
      repositoryKeys: [TOOLS],
    });
    expect(request.attach).toEqual([TOOLS]);
    expect(request.refused).toEqual([]);
    expect(request.plan.upserts).toEqual([
      {
        entry: { repositoryKey: TOOLS, state: "selected", origin: "inferred", rationale: REQUESTED, decidedBy: run, decidedAt: now },
        replacesExpired: false,
      },
    ]);
  });

  it("h) an outside_policy question answered none records excluded, and a later request is refused excluded", () => {
    const answered = decide(context({ actor: person, policy: null }), {
      kind: "answered",
      clarificationId: "clar-2",
      asked: [{ repositoryKey: API, askedBecause: "outside_policy" }],
      answer: { kind: "none" },
    });
    expect(answered.plan.upserts).toEqual([
      {
        entry: {
          repositoryKey: API,
          state: "excluded",
          origin: "person",
          rationale: DECLINED_OUTSIDE_POLICY,
          decidedBy: person,
          decidedAt: now,
        },
        replacesExpired: false,
      },
    ]);

    const later = decide(
      context({
        policy: { candidates: { kind: "listed", repositoryKeys: [WEB] }, expansion: "ask_once" },
        scope: scopeOf(
          entry({ repositoryKey: API, state: "excluded", origin: "person", rationale: DECLINED_OUTSIDE_POLICY, decidedBy: person }),
        ),
      }),
      { kind: "requested", repositoryKeys: [API] },
    );
    expect(later).toMatchObject({ ask: [], refused: [{ repositoryKey: API, reason: "excluded" }] });
  });

  it("i) a selection question answered none records nothing, and the next ambiguous ticket asks nothing", () => {
    const answered = decide(context({ actor: person, policy: null }), {
      kind: "answered",
      clarificationId: "clar-3",
      asked: [
        { repositoryKey: API, askedBecause: "selection" },
        { repositoryKey: WEB, askedBecause: "selection" },
      ],
      answer: { kind: "none" },
    });
    expect(answered.plan).toEqual({
      upserts: [],
      deletes: [],
      trail: [{ kind: "question_answered", clarificationId: "clar-3", answer: { kind: "none" }, answeredBy: person }],
    });

    const next = decide(context({ scope: scopeOf(), selectionAnswered: true }), {
      kind: "text_ambiguous",
      matchedKeys: [API, WEB],
    });
    expect(next.ask).toEqual([]);
  });

  it("j) a named key that is not enabled is selected, refused at run start until enabled, then attached past a listed policy", () => {
    const answered = decide(context({ actor: person, policy: null }), {
      kind: "answered",
      clarificationId: "clar-4",
      asked: [{ repositoryKey: LEGACY, askedBecause: "not_enabled" }],
      answer: { kind: "repositories", repositoryKeys: [LEGACY] },
    });
    expect(answered.plan.upserts).toEqual([
      {
        entry: { repositoryKey: LEGACY, state: "selected", origin: "person", rationale: NAMED, decidedBy: person, decidedAt: now },
        replacesExpired: false,
      },
    ]);

    const scope = scopeOf(
      entry({ repositoryKey: LEGACY, origin: "person", rationale: NAMED, decidedBy: person, decidedAt: now }),
    );
    expect(decide(context({ scope }), { kind: "run_started" })).toEqual({
      plan: {
        upserts: [],
        deletes: [],
        trail: [{ kind: "request_refused", repositoryKey: LEGACY, reason: "outside_catalog" }],
      },
      attach: [],
      ask: [],
      refused: [{ repositoryKey: LEGACY, reason: "outside_catalog" }],
      editRejected: [],
      trailTruncated: 0,
    });
    expect(
      decide(
        context({
          scope,
          catalog: catalogWithLegacy,
          policy: { candidates: { kind: "listed", repositoryKeys: [API] }, expansion: "never" },
        }),
        { kind: "run_started" },
      ),
    ).toEqual({ plan: emptyPlan, attach: [LEGACY], ask: [], refused: [], editRejected: [], trailTruncated: 0 });
  });

  it("k) edits on eight selected entries: a swap applies, an addition leaving nine is accepted, a swap for a key that is not enabled rejects only that key", () => {
    const eight = [
      "github:acme/s-1",
      "github:acme/s-2",
      "github:acme/s-3",
      "github:acme/s-4",
      "github:acme/s-5",
      "github:acme/s-6",
      "github:acme/s-7",
      "github:acme/s-8",
    ];
    const edit = context({
      actor: person,
      policy: null,
      attachedKeys: null,
      catalog: { activated: true, enabledKeys: [API, ...eight], unusableKeys: [] },
      scope: scopeOf(...eight.map((repositoryKey) => entry({ repositoryKey, origin: "person", decidedBy: person }))),
    });
    const selectedApi = { repositoryKey: API, state: "selected", origin: "person", rationale: "", decidedBy: person, decidedAt: now };

    const swap = decide(edit, {
      kind: "edited",
      changes: [
        { repositoryKey: "github:acme/s-1", action: "remove" },
        { repositoryKey: API, action: "select" },
      ],
    });
    expect(swap).toEqual({
      plan: {
        upserts: [{ entry: selectedApi, replacesExpired: false }],
        deletes: [{ repositoryKey: "github:acme/s-1", origin: "person" }],
        trail: [
          {
            kind: "entry_removed",
            entry: entry({ repositoryKey: "github:acme/s-1", origin: "person", decidedBy: person }),
            removedBy: person,
          },
          { kind: "entry_written", entry: selectedApi, previousState: null },
        ],
      },
      attach: [],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });

    expect(decide(edit, { kind: "edited", changes: [{ repositoryKey: API, action: "select" }] })).toEqual({
      plan: {
        upserts: [{ entry: selectedApi, replacesExpired: false }],
        deletes: [],
        trail: [{ kind: "entry_written", entry: selectedApi, previousState: null }],
      },
      attach: [],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });

    expect(
      decide(edit, {
        kind: "edited",
        changes: [
          { repositoryKey: "github:acme/s-1", action: "remove" },
          { repositoryKey: LEGACY, action: "select" },
        ],
      }),
    ).toEqual({
      plan: emptyPlan,
      attach: [],
      ask: [],
      refused: [],
      editRejected: [{ repositoryKey: LEGACY, reason: "not_enabled" }],
      trailTruncated: 0,
    });
  });

  it("l) a provider outside the pin is never attached or asked, whoever selected it", () => {
    const pinned = context({
      pinnedProviders: ["gitlab"],
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
    });

    expect(decide(pinned, { kind: "requested", repositoryKeys: [API] })).toMatchObject({
      attach: [],
      ask: [],
      refused: [{ repositoryKey: API, reason: "outside_policy" }],
    });
    expect(
      decide(
        { ...pinned, scope: scopeOf(entry({ repositoryKey: API, origin: "person", decidedBy: person })) },
        { kind: "run_started" },
      ),
    ).toMatchObject({ attach: [], ask: [], refused: [{ repositoryKey: API, reason: "outside_policy" }] });
  });

  it("l2) a repository outside the pinned keys is never attached or asked, whoever selected it", () => {
    const pinned = context({
      pinnedKeys: [WEB],
      policy: { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
    });

    expect(decide(pinned, { kind: "requested", repositoryKeys: [API] })).toMatchObject({
      attach: [],
      ask: [],
      refused: [{ repositoryKey: API, reason: "outside_policy" }],
    });
    expect(
      decide(
        { ...pinned, scope: scopeOf(entry({ repositoryKey: API, origin: "person", decidedBy: person })) },
        { kind: "run_started" },
      ),
    ).toMatchObject({ attach: [], ask: [], refused: [{ repositoryKey: API, reason: "outside_policy" }] });
    expect(decide(pinned, { kind: "requested", repositoryKeys: [WEB] })).toMatchObject({
      attach: [WEB],
      ask: [],
      refused: [],
    });
  });

  it("l3) where the path listed no repositories every enabled key is usable and an unusable entry does not expire", () => {
    const unlisted = context({
      catalog: { activated: true, enabledKeys: [API, BROKEN], unusableKeys: null },
      scope: scopeOf(
        entry({
          repositoryKey: BROKEN,
          state: "unavailable",
          unavailableReason: "unusable",
          origin: "person",
          rationale: LEFT_OUT_UNUSABLE,
          decidedBy: person,
        }),
        entry({ repositoryKey: API, origin: "person", rationale: NAMED, decidedBy: person }),
      ),
    });

    expect(decide(unlisted, { kind: "run_started" })).toMatchObject({
      attach: [API],
      ask: [],
      refused: [],
    });
    expect(decide(unlisted, { kind: "requested", repositoryKeys: [BROKEN] })).toMatchObject({
      attach: [],
      ask: [],
      refused: [{ repositoryKey: BROKEN, reason: "unavailable" }],
    });
  });

  it("m) run_started over forty selected entries outside the candidates: the trail stops at the contract bound, refused lists all forty", () => {
    const forty = Array.from({ length: 40 }, (_, index) => `github:acme/repo-${String(index + 1).padStart(2, "0")}`);
    const decision = decide(
      context({
        catalog: { activated: true, enabledKeys: [API, ...forty], unusableKeys: [] },
        policy: { candidates: { kind: "listed", repositoryKeys: [API] }, expansion: "never" },
        scope: scopeOf(...forty.map((repositoryKey) => entry({ repositoryKey, origin: "ticket_text" }))),
      }),
      { kind: "run_started" },
    );

    expect(decision.refused).toHaveLength(40);
    expect(decision.refused[39]).toEqual({ repositoryKey: "github:acme/repo-40", reason: "outside_policy" });
    expect(decision.plan.trail).toHaveLength(32);
    expect(decision.plan.trail[31]).toEqual({
      kind: "request_refused",
      repositoryKey: "github:acme/repo-32",
      reason: "outside_policy",
    });
    expect(decision.trailTruncated).toBe(8);
  });

  it("m2) run_started over one key recorded twice refuses it once", () => {
    const twice = entry({ repositoryKey: DOCS, origin: "ticket_text" });
    const decision = decide(
      context({
        policy: { candidates: { kind: "listed", repositoryKeys: [API] }, expansion: "never" },
        scope: scopeOf(twice, twice),
      }),
      { kind: "run_started" },
    );

    expect(decision.refused).toEqual([{ repositoryKey: DOCS, reason: "outside_policy" }]);
    expect(decision.plan.trail).toEqual([
      { kind: "request_refused", repositoryKey: DOCS, reason: "outside_policy" },
    ]);
    expect(decision.trailTruncated).toBe(0);
  });

  it("n) an unusable entry whose key becomes usable on a bridge catalog is attached at run start with replacesExpired", () => {
    const decision = decide(
      context({
        catalog: { activated: false, enabledKeys: [API, BROKEN], unusableKeys: [] },
        scope: scopeOf(
          entry({
            repositoryKey: BROKEN,
            state: "unavailable",
            unavailableReason: "unusable",
            origin: "person",
            rationale: LEFT_OUT_UNUSABLE,
            decidedBy: person,
          }),
        ),
      }),
      { kind: "run_started" },
    );

    const replaced = {
      repositoryKey: BROKEN,
      state: "selected",
      origin: "inferred",
      rationale:
        'Usable in the catalog since Filip recorded it as unusable ("Left out of the answer to a question asked because it could not be used.").',
      decidedBy: run,
      decidedAt: now,
    };
    expect(decision).toEqual({
      plan: {
        upserts: [{ entry: replaced, replacesExpired: true }],
        deletes: [],
        trail: [{ kind: "entry_written", entry: replaced, previousState: "unavailable" }],
      },
      attach: [BROKEN],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
  });

  it("o) a request for a disabled key of a provider outside the pin is refused outside_policy and nothing is asked", () => {
    const decision = decide(context({ pinnedProviders: ["gitlab"] }), { kind: "requested", repositoryKeys: [LEGACY] });

    expect(decision).toEqual({
      plan: {
        upserts: [],
        deletes: [],
        trail: [{ kind: "request_refused", repositoryKey: LEGACY, reason: "outside_policy" }],
      },
      attach: [],
      ask: [],
      refused: [{ repositoryKey: LEGACY, reason: "outside_policy" }],
      editRejected: [],
      trailTruncated: 0,
    });
  });

  it("p) another workflow's inferred entry for a key outside a listed ask_once policy is asked about, a person's entry for it attaches", () => {
    const policy = { candidates: { kind: "listed" as const, repositoryKeys: [API] }, expansion: "ask_once" as const };
    const event: WorkScopeDecisionEvent = { kind: "requested", repositoryKeys: [WEB] };

    expect(decide(context({ policy, scope: scopeOf(entry({ repositoryKey: WEB, origin: "inferred" })) }), event)).toEqual({
      plan: emptyPlan,
      attach: [],
      ask: [{ repositoryKey: WEB, askedBecause: "outside_policy" }],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
    expect(
      decide(
        context({ policy, scope: scopeOf(entry({ repositoryKey: WEB, origin: "person", rationale: NAMED, decidedBy: person })) }),
        event,
      ),
    ).toMatchObject({ attach: [WEB], ask: [], refused: [] });
  });
});

describe("decideWorkScope bounds", () => {
  const keys = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `github:acme/${prefix}-${index + 1}`);

  it("keeps an answer with eight asked and eight other named keys inside the contract", () => {
    const asked = keys("asked", 8);
    const named = keys("named", 8);
    const decision = decide(context({ actor: person, policy: null }), {
      kind: "answered",
      clarificationId: "clar-9",
      asked: asked.map((repositoryKey) => ({ repositoryKey, askedBecause: "outside_policy" as const })),
      answer: { kind: "repositories", repositoryKeys: named },
    });

    expect(decision.plan.upserts).toHaveLength(16);
    expect(decision.plan.trail).toHaveLength(17);
  });

  it("keeps an edit of sixteen changes inside the contract", () => {
    const held = keys("held", 8);
    const added = keys("added", 8);
    const decision = decide(
      context({
        actor: person,
        policy: null,
        attachedKeys: null,
        catalog: { activated: true, enabledKeys: [...held, ...added], unusableKeys: [] },
        scope: scopeOf(...held.map((repositoryKey) => entry({ repositoryKey, origin: "ticket_text" }))),
      }),
      {
        kind: "edited",
        changes: [
          ...held.map((repositoryKey) => ({ repositoryKey, action: "remove" as const })),
          ...added.map((repositoryKey) => ({ repositoryKey, action: "select" as const })),
        ],
      },
    );

    expect(decision.plan.deletes).toHaveLength(8);
    expect(decision.plan.upserts).toHaveLength(8);
    expect(decision.plan.trail).toHaveLength(16);
  });

  it("keeps a derivation of eight keys replacing eight others inside the contract", () => {
    const old = keys("old", 8);
    const derived = keys("new", 8);
    const decision = decide(
      context({
        catalog: { activated: true, enabledKeys: [...old, ...derived], unusableKeys: [] },
        scope: scopeOf(...old.map((repositoryKey) => entry({ repositoryKey, origin: "ticket_text" }))),
      }),
      { kind: "derived", origin: "ticket_text", repositoryKeys: derived, rationale: "Ticket text names them." },
    );

    expect(decision.plan.upserts).toHaveLength(8);
    expect(decision.plan.deletes).toHaveLength(8);
    expect(decision.plan.trail).toHaveLength(16);
  });

  it("keeps every entry write of a run start in the trail when refusals come first in walk order", () => {
    const refusedKeys = keys("aaa", 40);
    const expiredKeys = keys("zzz", 8);
    const decision = decide(
      context({
        catalog: { activated: true, enabledKeys: expiredKeys, unusableKeys: [] },
        scope: scopeOf(
          ...refusedKeys.map((repositoryKey) => entry({ repositoryKey, origin: "person", decidedBy: person })),
          ...expiredKeys.map((repositoryKey) =>
            entry({
              repositoryKey,
              state: "unavailable",
              unavailableReason: "not_enabled",
              origin: "person",
              rationale: LEFT_OUT_NOT_ENABLED,
              decidedBy: person,
            }),
          ),
        ),
      }),
      { kind: "run_started" },
    );

    expect(decision.refused).toHaveLength(40);
    expect(decision.attach).toEqual(expiredKeys);
    expect(decision.plan.upserts).toHaveLength(8);
    expect(decision.plan.trail).toHaveLength(32);
    expect(decision.plan.trail.filter((event) => event.kind === "entry_written")).toHaveLength(8);
    expect(decision.trailTruncated).toBe(16);
  });

  it("keeps a request of forty keys inside the contract", () => {
    const decision = decide(context(), { kind: "requested", repositoryKeys: keys("asked", 40) });

    expect(decision.refused).toHaveLength(37);
    expect(decision.plan.trail).toHaveLength(32);
    // The three keys the request asks about do not reach the trail: the decision
    // proposes the question, and the caller records it when it asks. So all 32
    // rows are refusals and five of the 37 are left out.
    expect(decision.trailTruncated).toBe(5);
  });

  it("asks at most eight matched keys", () => {
    const matched = keys("match", 8);
    const decision = decide(
      context({ catalog: { activated: true, enabledKeys: matched, unusableKeys: [] } }),
      { kind: "text_ambiguous", matchedKeys: matched },
    );

    expect(decision.ask).toHaveLength(8);
  });

  it("throws when a run event of a subject that carries a record has no resolved trigger policy", () => {
    const withoutPolicy = context({ policy: null, carriesRecord: true });

    expect(() => decideWorkScope(withoutPolicy, { kind: "run_started" })).toThrow();
    expect(() => decideWorkScope(withoutPolicy, { kind: "resumed", repositoryKeys: [API] })).toThrow();
    expect(() =>
      decideWorkScope(withoutPolicy, {
        kind: "derived",
        origin: "ticket_text",
        repositoryKeys: [API],
        rationale: "Ticket text names api.",
      }),
    ).toThrow();
    expect(() => decideWorkScope(withoutPolicy, { kind: "text_ambiguous", matchedKeys: [API, WEB] })).toThrow();
    expect(() => decideWorkScope(withoutPolicy, { kind: "requested", repositoryKeys: [API] })).toThrow();
  });

  it("decides a run start with no resolved trigger policy when the subject carries no record", () => {
    expect(decide(context({ policy: null, carriesRecord: false }), { kind: "run_started" })).toEqual({
      plan: emptyPlan,
      attach: [],
      ask: [],
      refused: [],
      editRejected: [],
      trailTruncated: 0,
    });
  });

  it("throws on more than eight derived, matched, asked or named keys", () => {
    const nine = keys("over", 9);

    expect(() =>
      decideWorkScope(context(), { kind: "derived", origin: "inferred", repositoryKeys: nine, rationale: "x" }),
    ).toThrow();
    expect(() => decideWorkScope(context(), { kind: "text_ambiguous", matchedKeys: nine })).toThrow();
    expect(() =>
      decideWorkScope(context({ actor: person, policy: null }), {
        kind: "answered",
        clarificationId: "clar-10",
        asked: nine.map((repositoryKey) => ({ repositoryKey, askedBecause: "selection" as const })),
        answer: { kind: "none" },
      }),
    ).toThrow();
    expect(() =>
      decideWorkScope(context({ actor: person, policy: null }), {
        kind: "answered",
        clarificationId: "clar-11",
        asked: [],
        answer: { kind: "repositories", repositoryKeys: nine },
      }),
    ).toThrow();
  });
});
