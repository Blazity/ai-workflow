/**
 * What this deployment's integrations let a workflow do.
 *
 * One pure function answers it for every surface: the editor palette, the
 * refusal a publish gives, the blocker a manual dispatch reports, and the
 * sentence a run fails with. They ask the same question, so they get the same
 * answer from the same code; a second derivation is how a palette and a run
 * come to disagree about the same deployment.
 *
 * Nothing here names an integration. It reads the manifests this build ships
 * and the state `services/integrations/resolve.ts` decided for each, both
 * passed in as data, so a test declares a deployment instead of arranging a
 * database, an environment and a generated registry file.
 *
 * It also never reads `verification`. A connection whose values are complete
 * and that nobody ever tested is usable, which is every deployment alive on
 * the day this lands; reading the test verdict here would empty their palettes.
 */
import { investigateSources } from "../blocks/investigate/manifest.js";
import type { IntegrationBlockManifest, IntegrationManifest } from "@integrations/sdk";
import type {
  IntegrationConnectionPin,
  IntegrationFailure,
  IntegrationState,
  IntegrationStatus,
  IntegrationUnavailableReason,
  WorkflowBlockAvailability,
} from "@shared/contracts";

/** One integration as the engine needs it. Carries no connection value. */
export interface IntegrationPresence {
  readonly id: string;
  readonly name: string;
  readonly status: IntegrationStatus;
  /** Enabled and connected. The one question the engine asks. */
  readonly usable: boolean;
  /** The provider's or the resolver's own sentence, when there is one. */
  readonly failure: IntegrationFailure | null;
  /** What a run pins at its start and compares at every later use. */
  readonly pin: IntegrationConnectionPin;
  readonly capabilities: readonly string[];
}

/** One block an integration contributes, and what it needs to run. */
interface IntegrationBlockRequirement {
  readonly integrationId: string;
  readonly capabilities: readonly string[];
  /** What the block declared: its ports, its parameters, its output. */
  readonly block: IntegrationBlockManifest;
}

/**
 * The deployment, as the resolver takes it: which integrations exist and in
 * what state, which blocks they contribute, who can serve each capability, and
 * which capabilities core still serves out of its own configuration.
 */
export interface DeploymentIntegrations {
  readonly byId: ReadonlyMap<string, IntegrationPresence>;
  readonly blocks: ReadonlyMap<string, IntegrationBlockRequirement>;
  /** Capability to the usable integrations that declare it, in manifest order. */
  readonly providers: ReadonlyMap<string, readonly string[]>;
  /**
   * Capabilities this deployment serves from core rather than from an
   * integration.
   *
   * Every one of them is a provider the plan moves out in a later stage
   * (ADR-010, decision 10 and stages S8 to S13). Until then a block that asks
   * for the capability gets core's own, which is what keeps a deployment
   * configured through its environment running with nothing to migrate.
   */
  readonly builtinCapabilities: ReadonlySet<string>;
  readonly botIdentityProviders: ReadonlySet<string>;
  readonly legacyBotIdentityProviders: ReadonlySet<string>;
}

/** A build with no integration at all: the shape every default takes. */
export const NO_INTEGRATIONS: DeploymentIntegrations = {
  byId: new Map(),
  blocks: new Map(),
  providers: new Map(),
  builtinCapabilities: new Set(),
  botIdentityProviders: new Set(),
  legacyBotIdentityProviders: new Set(),
};

export interface DeploymentIntegrationsInput {
  readonly manifests: readonly IntegrationManifest[];
  /** Keyed by integration id, as `readIntegrationStates()` returns it. */
  readonly states: ReadonlyMap<string, IntegrationState>;
  readonly builtinCapabilities?: Iterable<string>;
}

export function deploymentIntegrations(
  input: DeploymentIntegrationsInput,
): DeploymentIntegrations {
  const byId = new Map<string, IntegrationPresence>();
  const blocks = new Map<string, IntegrationBlockRequirement>();
  const providers = new Map<string, string[]>();
  const botIdentityProviders = new Set<string>();
  const legacyBotIdentityProviders = new Set<string>();

  for (const manifest of input.manifests) {
    const state = input.states.get(manifest.id);
    const presence: IntegrationPresence = {
      id: manifest.id,
      name: manifest.name,
      // A manifest with no state is one nothing has ever been said about. It
      // reads as not connected rather than as connected, because guessing the
      // other way would run a block against a connection nobody configured.
      status: state?.status ?? "not_connected",
      usable: state?.usable ?? false,
      failure: state?.failure ?? null,
      pin: state?.pin ?? { integrationId: manifest.id, configFingerprint: "" },
      capabilities: [...manifest.capabilities],
    };
    byId.set(manifest.id, presence);
    for (const block of manifest.blocks) {
      blocks.set(block.type, {
        integrationId: manifest.id,
        capabilities: [...(block.requires?.capabilities ?? [])],
        block,
      });
    }
    // Only a usable provider counts. An admin who disabled one of two trackers
    // has chosen, and asking them to choose again would be the product arguing
    // with an action they just took.
    if (!presence.usable) continue;
    if (manifest.capabilities.includes("vcs")) {
      if (state?.configuredFields?.includes("botLogin")) {
        botIdentityProviders.add(manifest.id);
      }
      if (state?.configuredFields?.includes("legacyBotLogin")) {
        legacyBotIdentityProviders.add(manifest.id);
      }
    }
    for (const capability of manifest.capabilities) {
      const holders = providers.get(capability) ?? [];
      holders.push(manifest.id);
      providers.set(capability, holders);
    }
  }

  return {
    byId,
    blocks,
    providers,
    builtinCapabilities: new Set(input.builtinCapabilities ?? []),
    botIdentityProviders,
    legacyBotIdentityProviders,
  };
}

const AVAILABLE: WorkflowBlockAvailability = { available: true, unavailableReason: null };

function unavailable(unavailableReason: string): WorkflowBlockAvailability {
  return { available: false, unavailableReason };
}

/**
 * Whether a block an integration contributes may be offered and run.
 *
 * `null` means the block is core's, so core's own rules decide. A block type no
 * integration in this build claims is answered rather than left to core: a
 * definition published while an integration existed keeps its node when the
 * build stops shipping it, and the node has to say what is missing instead of
 * crashing a palette or disappearing from a canvas.
 */
export function integrationBlockAvailability(
  type: string,
  integrations: DeploymentIntegrations,
  options: { readonly coreOwnsType?: boolean } = {},
): WorkflowBlockAvailability | null {
  const requirement = integrations.blocks.get(type);
  if (!requirement) {
    if (options.coreOwnsType === false) return unknownBlockTypeAvailability(type);
    return null;
  }
  const presence = integrations.byId.get(requirement.integrationId);
  if (!presence) return unknownBlockTypeAvailability(type);
  if (!presence.usable) return unavailable(integrationUnusableReason(presence));
  for (const capability of requirement.capabilities) {
    const issue = capabilityIssue(capability, integrations);
    if (issue) return unavailable(issue);
  }
  return AVAILABLE;
}

/** A block type nothing in this build provides, said in the author's terms. */
function unknownBlockTypeAvailability(type: string): WorkflowBlockAvailability {
  return unavailable(
    `No integration in this build provides the block "${type}". Connect the integration that added it, or remove the node.`,
  );
}

/** Why a person cannot use this integration right now, in one sentence. */
export function integrationUnusableReason(presence: IntegrationPresence): string {
  if (presence.status === "disabled") {
    return `${presence.name} is disabled. Enable it on the Integrations page to use this block.`;
  }
  if (presence.status === "failing") {
    const detail = presence.failure?.message ?? "the last connection test failed";
    return `${presence.name} is failing: ${detail}.`;
  }
  return `${presence.name} is not connected. Connect it on the Integrations page to use this block.`;
}

/**
 * Whether a capability has exactly one answer on this deployment, and whether
 * this build can actually hand a block that answer.
 *
 * Nobody serving it, and several serving it with nobody chosen, are both
 * refusals with a name, never a silent pick of the first: a block that posted
 * into one of two connected workspaces because it happened to be first in the
 * registry is the failure an admin cannot explain afterwards.
 *
 * The third case is ours rather than the admin's, and it is why an integration
 * that declares a capability does not yet satisfy one. Execution hands a block
 * whichever adapter core builds from its own configuration
 * (`engine/support/integration-capabilities.ts`), so offering the block because
 * an integration declared the capability would promise one provider in the
 * palette and use another in the run. Stages S8 to S13 replace each built-in
 * with the integration that declared it, and this refusal goes with them.
 */
/**
 * Capabilities core can hand a block from an integration's own adapter.
 *
 * It exists because availability and execution have to agree about which
 * provider serves a block. A capability core cannot yet reach through an
 * integration is refused by name, however many integrations declare it; each
 * of stages S9 to S13 adds its capability here in the same change that teaches
 * execution to resolve it. S9 added `messaging`
 * (`engine/support/messaging.ts`).
 */
const INTEGRATION_SERVED_CAPABILITIES: ReadonlySet<string> = new Set(["messaging", "vcs"]);

/**
 * The same question for a CORE block that needs a capability.
 *
 * A core block has no manifest to declare a requirement in, so its rule stays
 * in the resolver; the answer has to be the one an integration block would
 * get, or the palette says two things about one deployment.
 */
export function coreCapabilityIssue(
  capability: string,
  integrations: DeploymentIntegrations,
): string | null {
  return capabilityIssue(capability, integrations);
}

function capabilityIssue(
  capability: string,
  integrations: DeploymentIntegrations,
): string | null {
  const holders = integrations.providers.get(capability) ?? [];
  const label = capabilityLabel(capability);
  if (capability === "vcs") {
    if (integrations.builtinCapabilities.has(capability) || holders.length > 0) return null;
    const idle = [...integrations.byId.values()].filter(
      (presence) => presence.capabilities.includes(capability) && !presence.usable,
    );
    if (idle.length > 0) {
      const names = idle.map((presence) => presence.name).join(" and ");
      return `${names} would provide the ${label} capability this block needs, but is not connected. Finish connecting it on the Integrations page.`;
    }
    return `Nothing on this deployment provides the ${label} capability, which this block needs. Connect an integration that provides it on the Integrations page.`;
  }
  if (!integrations.builtinCapabilities.has(capability)) {
    if (holders.length === 0) {
      // A provider that ships and declares the capability but is not usable is
      // named, with the state it is in. "Nothing provides messaging" in front
      // of an admin who can see Slack on the Integrations page is a sentence
      // that sends them looking for a second provider they do not need.
      const idle = [...integrations.byId.values()].filter(
        (presence) => presence.capabilities.includes(capability) && !presence.usable,
      );
      if (idle.length > 0) {
        const names = idle.map((presence) => presence.name).join(" and ");
        return idle.every((presence) => presence.status === "disabled")
          ? `${names} would provide the ${label} capability this block needs, but is switched off. Enable it on the Integrations page.`
          : `${names} would provide the ${label} capability this block needs, but is not connected. Finish connecting it on the Integrations page.`;
      }
      return `Nothing on this deployment provides the ${label} capability, which this block needs. Connect an integration that provides it on the Integrations page.`;
    }
    if (!INTEGRATION_SERVED_CAPABILITIES.has(capability)) {
      const names = holders.map((id) => integrations.byId.get(id)?.name ?? id);
      return `This build cannot yet run a block on the ${label} capability served by an integration (${names.join(", ")}); core still owns that capability. It becomes available when that integration takes the capability over.`;
    }
    if (holders.length === 1) return null;
    const names = holders.map((id) => integrations.byId.get(id)?.name ?? id);
    return `${names.join(" and ")} both provide the ${label} capability. Disable the ones you do not want until the Integrations page can select an active provider.`;
  }
  if (holders.length === 0) return null;
  const names = holders.map((id) => integrations.byId.get(id)?.name ?? id);
  // Selecting the active provider of a capability is the Integrations page's
  // job and ships with it in S6 (ADR-010). Until then the way to choose is to
  // disable the ones you do not want, and the sentence says that rather than
  // sending an admin to a control nobody has built.
  return `${[...names, "this deployment's built-in provider"].join(" and ")} all provide the ${label} capability. Disable the ones you do not want until the Integrations page can select an active provider.`;
}

/** The capability's id as a person reads it. Names no provider. */
function capabilityLabel(capability: string): string {
  if (capability === "vcs") return "version control";
  return capability.replace(/_/g, " ");
}

const NO_CAPABILITIES: readonly string[] = [];
const MESSAGING = "messaging";
const VCS = "vcs";
const ISSUE_TRACKER = "issue_tracker";
const MEMORY = "memory";
const AGENT_TRACING = "agent_tracing";

/** Blocks that cannot be offered without version control: the triggers that
 *  fire on a pull request and the blocks that call the provider directly. */
const VCS_BLOCKS = new Set([
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
  "prepare_workspace",
  "finalize_workspace",
  "run_pre_pr_checks",
  "run_checks",
  "fetch_pr_context",
  "open_pr",
  "post_pr_comment",
  "create_pr_check",
  "complete_pr_check",
  "post_pr_review",
]);

/**
 * Blocks that prepare the run's workspace, explicitly or on their first use,
 * through `ensureWorkspace` in `blocks/prepare-workspace/execute.ts`:
 * prepare_workspace (agent-workflow.ts:2918), planning_agent (:3034, through
 * `ensureCodeWorkspace`), implementation_agent (:3654), review_agent (:3876)
 * and fix_agent (blocks/fix-agent/execute.ts:661).
 *
 * Preparing reaches three capabilities: version control, to resolve and clone
 * the repositories; agent tracing, because the sandbox is configured with every
 * tracing provider (`agentTracingRun`, prepare-workspace/execute.ts:1322); and
 * memory, hydrated into the workspace (:1394, seeded at :1437) and captured
 * back when the run tears it down (agent-workflow.ts:5044).
 */
const WORKSPACE_PREPARING_BLOCKS = new Set([
  "prepare_workspace",
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
]);

/**
 * Blocks that run an agent in a sandbox without preparing a workspace
 * themselves. Every agent sandbox is configured with every tracing provider
 * (generic_agent through `ensureAgentSandbox`, blocks/agent-sandbox.ts:276).
 */
const AGENT_SANDBOX_BLOCKS = new Set(["generic_agent"]);

/**
 * Blocks that read or write a ticket through the issue tracker.
 *
 * The ticket triggers make the whole run about a ticket, so they stand for
 * what every run they start reaches whatever its blocks are: the ticket is
 * read at dispatch (services/dispatch/dispatch.ts:109), moved back to the
 * backlog when the run fails (agent-workflow.ts:686) and on to AI Review when
 * it finishes (:1373). A plan approval continues a ticket's run
 * (services/approvals/dispatch.ts:46). The rest call it themselves:
 * post_ticket_comment (blocks/post-ticket-comment/execute.ts:14),
 * send_plan_approval (blocks/send-plan-approval/execute.ts:72) and
 * update_ticket_status (agent-workflow.ts:4472).
 */
const ISSUE_TRACKER_BLOCKS = new Set([
  "trigger_ticket_ai",
  "trigger_plan_approved",
  "post_ticket_comment",
  "send_plan_approval",
  "update_ticket_status",
]);

/** What a core block needs from the deployment's capabilities. */
export interface CoreBlockCapabilities {
  /**
   * What the block cannot be offered without. Block availability refuses the
   * block when one of these has no single usable provider, so this is the
   * palette's and the publish gate's question. Deliberately narrower than
   * `reached`: an agent block without a tracing provider runs untraced, and
   * one without a memory integration uses the built-in store.
   */
  readonly required: readonly string[];
  /**
   * Every capability a run executing this block reaches, `required` included.
   * Run pinning and "which workflows use this integration" read this, because
   * both ask what a run touches, not what the palette gates on: a run that
   * pinned less would follow a live change for what it left out, and a
   * disable preview that counted less would promise a disable stops nothing.
   */
  readonly reached: readonly string[];
}

/**
 * The capabilities a core block consumes, given its parameters.
 *
 * An integration's block declares this in its manifest. A core block has no
 * manifest, so it is declared here, once, and read by everything that needs
 * the answer: whether the block can be offered at all (`required`), which
 * providers the run pins, and which workflows a change to an integration
 * reaches (`reached`, through `integrationsUsedBy`). One statement, because
 * three is how a palette, a run and a disable preview come to disagree about
 * the same deployment.
 */
export function coreBlockCapabilities(
  type: string,
  params: Readonly<Record<string, unknown>> | undefined,
): CoreBlockCapabilities {
  const required: string[] = [];
  const reached: string[] = [];
  const need = (capability: string): void => {
    if (!required.includes(capability)) required.push(capability);
    use(capability);
  };
  const use = (capability: string): void => {
    if (!reached.includes(capability)) reached.push(capability);
  };

  if (ISSUE_TRACKER_BLOCKS.has(type)) use(ISSUE_TRACKER);
  if (VCS_BLOCKS.has(type)) need(VCS);
  if (WORKSPACE_PREPARING_BLOCKS.has(type)) {
    use(VCS);
    use(MEMORY);
    use(AGENT_TRACING);
  }
  if (AGENT_SANDBOX_BLOCKS.has(type)) use(AGENT_TRACING);
  if (type === "send_message") need(MESSAGING);
  if (type === "investigate") {
    const sources = investigateSources(params);
    if (sources.issueTracker) use(ISSUE_TRACKER);
    if (sources.chat) need(MESSAGING);
  }
  return {
    required: required.length > 0 ? required : NO_CAPABILITIES,
    reached: reached.length > 0 ? reached : NO_CAPABILITIES,
  };
}

/**
 * Every integration a definition's nodes reach, in first-use order.
 *
 * A node reaches one in three ways: it is an integration's own block, it is an
 * integration's block that requires a capability another integration serves,
 * or it is a core block that reaches a capability an integration serves. All
 * count. A run that pinned only the first kind would follow a live
 * configuration change for the others, so changing where a workflow posts,
 * mid-run, would go unnoticed by the very mechanism built to notice it; and a
 * disable preview that counted only the first would report that switching off
 * the tracker every ticket workflow runs on stops nothing.
 *
 * Only usable providers are named (`providers` holds nothing else), so a
 * capability nobody serves adds nothing here: its refusal is block
 * availability's to give.
 */
export function integrationsUsedBy(
  nodes: readonly {
    readonly type: string;
    readonly params?: Readonly<Record<string, unknown>>;
  }[],
  integrations: DeploymentIntegrations,
): readonly string[] {
  const used: string[] = [];
  const add = (id: string): void => {
    if (!used.includes(id)) used.push(id);
  };
  const addProvidersOf = (capability: string): void => {
    for (const id of integrations.providers.get(capability) ?? []) add(id);
  };
  for (const node of nodes) {
    const requirement = integrations.blocks.get(node.type);
    if (requirement) {
      add(requirement.integrationId);
      for (const capability of requirement.capabilities) addProvidersOf(capability);
      continue;
    }
    for (const capability of coreBlockCapabilities(node.type, node.params).reached) {
      addProvidersOf(capability);
    }
  }
  return used;
}

/**
 * The sentence a run stops with when an integration it pinned moved under it.
 *
 * One sentence for the run view, the ticket comment and the log, because the
 * three answer the same question for the same person: why did my run stop, and
 * what do I do about it.
 */
export function integrationUnavailableFailureMessage(input: {
  readonly integrationName: string;
  readonly reason: IntegrationUnavailableReason;
  /** What the same state reads as everywhere else. A connection that is failing
   *  reports `disconnected`, because the run-facing reasons are three and stay
   *  three, and a run that answered "no longer connected" for it would
   *  contradict the card, the palette and the dispatch blocker about one state. */
  readonly status?: IntegrationStatus;
  readonly failure?: IntegrationFailure | undefined;
}): string {
  const { integrationName, reason, status, failure } = input;
  if (reason === "disabled") {
    return `${integrationName} was disabled while this run was in flight, so the run stopped at its next use of it. Enable it on the Integrations page and run again.`;
  }
  if (reason === "reconfigured") {
    return `${integrationName} was reconfigured while this run was in flight, so the run stopped at its next use of it rather than mixing the connection it started with and the one in force now. Run again to use the new connection.`;
  }
  const detail = failure?.message;
  if (status === "failing") {
    return detail
      ? `${integrationName} is failing, so the run stopped at its next use of it: ${detail}.`
      : `${integrationName} is failing, so the run stopped at its next use of it. Fix the connection on the Integrations page and run again.`;
  }
  return detail
    ? `${integrationName} is no longer connected, so the run stopped at its next use of it: ${detail}.`
    : `${integrationName} is no longer connected, so the run stopped at its next use of it. Reconnect it on the Integrations page and run again.`;
}
