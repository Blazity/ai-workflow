import {
  McpPublicError,
  type McpActorContext,
  type McpScope,
  type McpToolName,
} from "./contracts.js";

type McpMutationClass = "read" | "direct" | "confirmed";
type McpRole = McpActorContext["role"];

export type McpToolPolicy = {
  scope: McpScope;
  roles: readonly McpRole[];
  mutation: McpMutationClass;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

const READ_POLICY = {
  scope: "mcp:read",
  roles: ["member", "admin", "owner", "service"],
  mutation: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const satisfies McpToolPolicy;

const DISPATCH_POLICY = {
  scope: "runs:dispatch",
  roles: ["admin", "owner", "service"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const satisfies McpToolPolicy;

// The one write that changes what OTHER agents are told to do, which is why it
// shares nothing with the dispatch policy above.
//
// Its own scope, because consent is per scope (contracts.ts:4) and rewriting the
// system's instructions is not what a token minted to read tickets and fire runs
// was agreed to do.
//
// And no "service" role, unlike DISPATCH_POLICY: an automation has no business
// rewriting a production prompt with no human behind it. request-context.ts already
// strips this scope out of a service actor's set, so a client_credentials token
// cannot reach here holding it; this list is what still refuses the call if a future
// token shape ever does.
const PROMPT_WRITE_POLICY = {
  scope: "prompts:write",
  roles: ["admin", "owner"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    // Nothing is deleted and a pinned {{prompt:slug@N}} keeps resolving to the
    // version it names, but the head this replaces is what every UNPINNED
    // reference resolves for every future run, so a client must not treat it as a
    // safe append it may probe with.
    destructiveHint: true,
    // A repeat under the same idempotency key replays the first answer rather
    // than stacking a second version.
    idempotentHint: true,
    // The effect stays inside this deployment's own library: nothing is started in
    // Jira or the VCS, which is what openWorldHint marks on a dispatch.
    openWorldHint: false,
  },
} as const satisfies McpToolPolicy;

// The highest privilege on this surface. A workflow is the instruction the
// platform executes with its own credentials: whoever writes one decides which
// repositories are cloned, what an agent is told to do inside them and what is
// pushed back. Everything the dispatch policy protects is downstream of it.
//
// Its own scope, for the reason contracts.ts:12 gives: consent to fire a reviewed
// workflow is not consent to write a new one. No "service", for the same reason
// prompts:write refuses it, and request-context.ts keeps the scope out of a service
// actor's set so an unattended automation does not hold it in the first place.
const WORKFLOW_WRITE_POLICY = {
  scope: "workflows:write",
  roles: ["admin", "owner"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    // Creating a definition and saving a draft take nothing away: every save is a
    // new immutable version and no draft is what any trigger fires. Publishing is
    // the one that replaces a live head, and it says so below.
    destructiveHint: false,
    // A repeat under the same idempotency key replays the first answer rather
    // than creating a second definition or stacking a second version.
    idempotentHint: true,
    // Nothing outside this deployment's own tables is touched while a graph is
    // only authored.
    openWorldHint: false,
  },
} as const satisfies McpToolPolicy;

// Publishing is where an authored graph stops being a document. It replaces the
// snapshot every future dispatch resolves against, and store.ts:1211-1212 mints
// the webhook endpoints and syncs the schedule rows of the new head, so a schedule
// node published here starts producing runs from a clock with nobody calling
// anything again. That is an open world and a destructive replacement, and a
// client must not treat it as the safe half of authoring.
const WORKFLOW_PUBLISH_POLICY = {
  ...WORKFLOW_WRITE_POLICY,
  annotations: {
    ...WORKFLOW_WRITE_POLICY.annotations,
    destructiveHint: true,
    openWorldHint: true,
  },
} as const satisfies McpToolPolicy;

/**
 * Answering the question a parked run asked. Rides runs:dispatch rather than a scope
 * of its own: it starts no new work and authors nothing, it delivers the one input a
 * run already asked a person for, and consent to fire runs is consent to see them
 * through.
 *
 * The role list is where this policy says something the others do not. It admits
 * "member", against the pattern of every other mutation here, because the dashboard
 * deliberately admits every org member to exactly this action ("answering a
 * clarification is a user decision", clarifications/[id]/answer.post.ts) and MCP is a
 * transport, not a second authorization domain. Refusing a member here would buy no
 * safety at all, since the same person answers in the dashboard in one click.
 *
 * And it refuses "service", which DISPATCH_POLICY allows. A token with no `sub` has
 * nobody behind it, and a machine answering a question addressed to a human defeats
 * the purpose of having asked: the run parked precisely because it needed a person.
 * Note what does NOT protect this: withoutAuthoringScopes (request-context.ts) takes
 * only prompts:write and workflows:write away from a service actor, never
 * runs:dispatch, which smoke and dogfood automation legitimately hold. So unlike the
 * authoring tools, this list is the ONLY lock on that invariant. Keep it closed, and
 * see run-control.test.ts, which fails if it ever opens.
 */
const CLARIFICATION_ANSWER_POLICY = {
  scope: "runs:dispatch",
  roles: ["member", "admin", "owner"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    // Nothing is torn down or replaced: a parked run is resumed with the answer it
    // asked for, which is the outcome the person waiting on it wants.
    destructiveHint: false,
    // A repeat under the same idempotency key replays the first answer, and the
    // domain core treats an identical answer as a convergent retry rather than a
    // second delivery.
    idempotentHint: true,
    // The resumed run goes straight back to work on somebody's ticket and
    // repositories, and the answer itself moves the ticket's column.
    openWorldHint: true,
  },
} as const satisfies McpToolPolicy;

/**
 * Stopping a run. Rides runs:dispatch and keeps the dispatch role list exactly, down
 * to "service": this is the same authority as the dashboard's cancel-by-id route
 * (canDispatchWorkflowRuns, cancel.post.ts), and whoever may start work on a subject
 * is who may stop it. Unlike answering a question, there is no human addressee here,
 * so an unattended automation cleaning up its own dispatch is a legitimate caller.
 */
const CANCEL_POLICY = {
  scope: "runs:dispatch",
  roles: ["admin", "owner", "service"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    // The one mutation on this surface that takes something away and cannot give it
    // back: the sandbox is torn down, the partial work in it is gone and the run is
    // settled as blocked. A client must never probe with this.
    destructiveHint: true,
    // Cancelling a cancelled run is not a second cancellation: the repeat replays
    // under the same key, and a fresh key sees already_terminal as data.
    idempotentHint: true,
    // Reaches Workflow and the sandbox provider, and releases the subject claim that
    // other triggers are queued behind.
    openWorldHint: true,
  },
} as const satisfies McpToolPolicy;

/**
 * The ticket write side. Its own scope for the reason contracts.ts gives: this is the
 * first authority on the surface whose effect is visible to somebody else's team.
 *
 * Keeps "service", unlike the authoring tools and unlike answering a clarification. The
 * platform comments on and moves tickets on every run it executes, with no human behind
 * any of it, so an unattended client doing the same is the normal case rather than the
 * dangerous one. request-context.ts is where that difference is recorded.
 *
 * Adding a comment is additive and stays inside the tracker, so the base policy is the
 * mild one and the two tools with sharper edges override what they need below.
 */
const TICKET_WRITE_POLICY = {
  scope: "tickets:write",
  roles: ["admin", "owner", "service"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    // A repeat under the same idempotency key replays, and each tool also checks the
    // tracker itself before writing, because a provider has no idempotency key.
    idempotentHint: true,
    // The write lands in a system this deployment does not own and people read it.
    openWorldHint: true,
  },
} as const satisfies McpToolPolicy;

// Moving a ticket is the one ticket write that starts and stops WORK: into the AI
// column dispatches a run, out of it while a run is live is what a human abort looks
// like to the webhook. Destructive, because the caller can take somebody's run away
// with it, and it must not read as a safe metadata edit.
const TICKET_TRANSITION_POLICY = {
  ...TICKET_WRITE_POLICY,
  annotations: { ...TICKET_WRITE_POLICY.annotations, destructiveHint: true },
} as const satisfies McpToolPolicy;

const DISPATCH_PREFLIGHT_POLICY = {
  ...READ_POLICY,
  scope: DISPATCH_POLICY.scope,
  roles: DISPATCH_POLICY.roles,
} as const satisfies McpToolPolicy;

// Reading a whole authorable graph: every node's configuration, the pinned
// repositories, and the revision tokens a save or a publish is gated on. It is the
// read half of authoring, exactly what workflows.save_draft consumes, so it rides
// workflows:write and its role list the way dispatch_preflight rides runs:dispatch
// -- discovery that feeds a privileged action is gated behind that action's scope.
// workflows.list stays mcp:read because naming what exists is coarse discovery; this
// hands back the instruction itself, so it costs the authoring consent.
const WORKFLOW_GRAPH_READ_POLICY = {
  ...READ_POLICY,
  scope: WORKFLOW_WRITE_POLICY.scope,
  roles: WORKFLOW_WRITE_POLICY.roles,
} as const satisfies McpToolPolicy;

// Flipping a definition's enable switch, the same switch the dashboard's toggle sets
// and the one workflows.publish INHERITS rather than changes. Enabling arms the
// deployed head's real-event triggers -- the store mints the webhook endpoints and
// syncs the schedule rows of a live head -- so from that moment real ticket and pull
// request events execute the graph, and disabling releases those bindings again. That
// is the same destructive, open-world replacement of what the platform runs that a
// publish is, so it takes the publish annotations, and it rides the same
// workflows:write scope and admin/owner list: deciding what runs for real events is
// the authoring authority, not the dispatch one.
const WORKFLOW_SET_ENABLED_POLICY = WORKFLOW_PUBLISH_POLICY;

const TOOL_POLICY = {
  "system.capabilities": READ_POLICY,
  "tickets.get": READ_POLICY,
  "tickets.list_runs": READ_POLICY,
  "runs.get": READ_POLICY,
  "runs.trace": READ_POLICY,
  "runs.result": READ_POLICY,
  "runs.diagnose": READ_POLICY,
  "workflows.dispatch_preflight": DISPATCH_PREFLIGHT_POLICY,
  "workflows.dispatch": DISPATCH_POLICY,
  // Plain reads, not the dispatch scope: listing what exists is what an agent
  // does BEFORE it knows whether it may dispatch anything, and gating discovery
  // behind runs:dispatch would leave a read-only client unable to name a single
  // definition. Choosing to fire one still costs the dispatch scope.
  "workflows.list": READ_POLICY,
  "prompts.list": READ_POLICY,
  "prompts.get": READ_POLICY,
  "prompts.update": PROMPT_WRITE_POLICY,
  "workflows.create": WORKFLOW_WRITE_POLICY,
  "workflows.save_draft": WORKFLOW_WRITE_POLICY,
  "workflows.publish": WORKFLOW_PUBLISH_POLICY,
  // A read shaped like the authoring writes it feeds, and the enable switch those
  // writes inherit but never set. See the two policies above for why both ride
  // workflows:write rather than mcp:read or runs:dispatch.
  "workflows.get_graph": WORKFLOW_GRAPH_READ_POLICY,
  "workflows.set_enabled": WORKFLOW_SET_ENABLED_POLICY,
  // A plain read: seeing THAT a run is waiting and what it asked is what a
  // read-only client needs to report a stuck run to a person, and gating it behind
  // the dispatch scope would hide the question from the client most likely to be
  // watching.
  "runs.get_clarification": READ_POLICY,
  "runs.answer_clarification": CLARIFICATION_ANSWER_POLICY,
  "runs.cancel": CANCEL_POLICY,
  "tickets.comment": TICKET_WRITE_POLICY,
  "tickets.transition": TICKET_TRANSITION_POLICY,
  "tickets.create": TICKET_WRITE_POLICY,
  // Plain reads, same reasoning as workflows.list above: the block catalog is
  // this deployment's own static configuration, not a customer's data, and an
  // agent needs it BEFORE it knows whether it may author or dispatch anything.
  "blocks.list": READ_POLICY,
  "blocks.get": READ_POLICY,
  // A rollup over runs.get's own data, gated the same way: seeing how the fleet
  // has been doing costs nothing beyond what runs.get already exposes one run
  // at a time.
  "runs.stats": READ_POLICY,
} satisfies Record<McpToolName, McpToolPolicy>;

export function policyFor(tool: McpToolName): McpToolPolicy {
  return TOOL_POLICY[tool];
}

export function authorizeTool(actor: McpActorContext, tool: McpToolName): void {
  const policy = policyFor(tool);
  if (!actor.scopes.has(policy.scope)) {
    throw new McpPublicError("INSUFFICIENT_SCOPE", "Insufficient scope", false);
  }
  if (!policy.roles.includes(actor.role)) {
    throw new McpPublicError("FORBIDDEN", "Access denied", false);
  }
}
