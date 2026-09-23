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
import {
  capabilityLabel as sdkCapabilityLabel,
  VCS_BOT_LOGIN_FIELD,
  VCS_LEGACY_BOT_LOGIN_FIELD,
  type IntegrationBlockManifest,
  type IntegrationManifest,
} from "@integrations/sdk";
import type {
  IntegrationConnectionPin,
  IntegrationFailure,
  IntegrationState,
  IntegrationStatus,
  IntegrationUnavailableReason,
  WorkflowBlockAvailability,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { workflowWorkspaceAccessOf } from "@shared/workflow-graph";

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
  /** The states its webhook reports a review in, as its manifest declares them. */
  readonly reviewStates: readonly string[];
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
 * what state, which blocks they contribute, and who can serve each capability.
 *
 * Every provider of a capability is an integration and is counted once, in
 * `providers`. Until S12 core also served some capabilities out of its own
 * configuration and a second list said which; by then that list only ever
 * repeated a connected integration, so a connected Jira counted twice and
 * every block that required the issue tracker was refused as ambiguous. It is
 * gone rather than emptied, so nothing can count a provider a second time.
 * (Memory's built-in store is a provider core serves by itself, and it has a
 * rule of its own rather than a place in this list.)
 */
export interface DeploymentIntegrations {
  readonly byId: ReadonlyMap<string, IntegrationPresence>;
  readonly blocks: ReadonlyMap<string, IntegrationBlockRequirement>;
  /** Capability to the usable integrations that declare it, in manifest order. */
  readonly providers: ReadonlyMap<string, readonly string[]>;
  readonly botIdentityProviders: ReadonlySet<string>;
  readonly legacyBotIdentityProviders: ReadonlySet<string>;
}

/** A build with no integration at all: the shape every default takes. */
export const NO_INTEGRATIONS: DeploymentIntegrations = {
  byId: new Map(),
  blocks: new Map(),
  providers: new Map(),
  botIdentityProviders: new Set(),
  legacyBotIdentityProviders: new Set(),
};

export interface DeploymentIntegrationsInput {
  readonly manifests: readonly IntegrationManifest[];
  /** Keyed by integration id, as `readIntegrationStates()` returns it. */
  readonly states: ReadonlyMap<string, IntegrationState>;
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
      reviewStates: [...(manifest.webhook?.reviewStates ?? [])],
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
      if (state?.configuredFields?.includes(VCS_BOT_LOGIN_FIELD)) {
        botIdentityProviders.add(manifest.id);
      }
      if (state?.configuredFields?.includes(VCS_LEGACY_BOT_LOGIN_FIELD.key)) {
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
 * Capabilities core can hand a block from an integration's own adapter
 * (`integrationCapabilityAccess` in `engine/support/integration-capabilities.ts`).
 *
 * It exists because availability and execution have to agree about which
 * provider serves a block: a capability declared in `requires` that execution
 * cannot reach through an integration is refused by name, however many
 * integrations declare it, rather than offered in the palette and missing in
 * the run. `messaging` came with S9, `vcs` with S10 and S11, `issue_tracker`
 * with S12. A capability that joins execution joins this set in the same
 * change. `memory` never reaches this check: it is answered first by the
 * rule a run is answered by.
 */
const INTEGRATION_SERVED_CAPABILITIES: ReadonlySet<string> = new Set([
  "issue_tracker",
  "messaging",
  "vcs",
]);

/**
 * Who serves a capability that one provider serves at a time, given the
 * providers usable for it: nobody, exactly one, or several with nobody chosen.
 *
 * THE ONE STATEMENT OF THAT RULE. The issue tracker's and messaging's runtimes
 * ask it when a run reaches them, the palette asks it here
 * (`capabilityIssue`), and the Integrations page and MCP ask it through the
 * capability overview, so a deployment cannot be told on one screen that a
 * provider serves it while its runs are refused as ambiguous. Memory is the
 * exception, with a rule of its own, because its built-in store answers when
 * nothing is connected.
 *
 * Several is an answer with every name in it, never a silent pick of the
 * first: a run that posted into one of two connected workspaces because it
 * happened to be first in the registry is the failure an admin cannot explain
 * afterwards. Choosing one is disabling the others today; when the
 * Integrations page can select an active provider (plan decision 9), the
 * selection is read here and nowhere else.
 */
export type ActiveProvider<T> =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly provider: T }
  | { readonly kind: "ambiguous"; readonly providers: readonly T[] };

export function activeProviderOf<T>(usable: readonly T[]): ActiveProvider<T> {
  if (usable.length === 0) return { kind: "none" };
  if (usable.length > 1) return { kind: "ambiguous", providers: usable };
  return { kind: "one", provider: usable[0] as T };
}

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

/**
 * Whether a capability has an answer a block can be handed on this
 * deployment, or the sentence that says why not.
 *
 * Nobody serving it names the provider that would, in the state it is in, so
 * an admin who can see it on the Integrations page is not sent looking for a
 * second one. For a capability one provider serves at a time, several usable
 * is a refusal with every name in it (`activeProviderOf`). Version control is
 * served by every usable provider at once, per repository, so one is enough
 * and two are not a choice to make.
 */
function capabilityIssue(
  capability: string,
  integrations: DeploymentIntegrations,
): string | null {
  // Memory is answered by its own rule, the one every run is answered by: a
  // block has no key for it, so "offered" can only mean "runs here remember".
  if (capability === MEMORY) return memoryIssue(integrations);
  const holders = integrations.providers.get(capability) ?? [];
  const label = capabilityLabel(capability);
  if (holders.length === 0) {
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
  const names = holders.map((id) => integrations.byId.get(id)?.name ?? id);
  if (!INTEGRATION_SERVED_CAPABILITIES.has(capability)) {
    return `This build cannot yet run a block on the ${label} capability served by an integration (${names.join(", ")}); core does not hand a block that capability. It becomes available when execution does.`;
  }
  if (capability === VCS) return null;
  const active = activeProviderOf(names);
  if (active.kind !== "ambiguous") return null;
  // Selecting the active provider of a capability is not built yet (plan
  // decision 9). Until it is, the way to choose is to disable the ones you do
  // not want, and the sentence says that rather than sending an admin to a
  // control nobody has built.
  return `${active.providers.join(" and ")} both provide the ${label} capability. Disable the ones you do not want until the Integrations page can select an active provider.`;
}

/**
 * Who answers memory on this deployment. THE ONE RULE, read by every run
 * (`activeMemory` in `engine/support/memory-runtime.ts`) and by the palette (a
 * block that requires `memory`), so an editor cannot offer a block on memory
 * that the run it starts will not have.
 *
 * An integration counts once an admin has switched it on and configured it,
 * working or not (`connected` or `failing`). Nothing counted means the
 * built-in store: memory is the one capability core serves by itself, so that
 * is the default deployment rather than a refusal. One counted replaces the
 * built-in store, and when it is failing it is still the one chosen: serving
 * the built-in store instead would split the deployment's memory across two
 * stores with nobody told. Two counted is a choice nobody made, and a failing
 * one counts toward it, so a refused key cannot quietly hand memory to the
 * other engine. Disabled and never connected are the admin's choice to use
 * the built-in store.
 */
export type MemoryProviderChoice =
  | { readonly kind: "builtin" }
  | { readonly kind: "integration"; readonly id: string }
  | { readonly kind: "failing"; readonly id: string }
  | { readonly kind: "ambiguous"; readonly ids: readonly string[] };

export function memoryProviderChoice(
  integrations: Iterable<{
    readonly id: string;
    readonly status: IntegrationStatus;
    readonly capabilities: readonly string[];
  }>,
): MemoryProviderChoice {
  const chosen = [...integrations].filter(
    (integration) =>
      integration.capabilities.includes(MEMORY) &&
      (integration.status === "connected" || integration.status === "failing"),
  );
  const [only] = chosen;
  if (!only) return { kind: "builtin" };
  if (chosen.length > 1) return { kind: "ambiguous", ids: chosen.map((integration) => integration.id) };
  return only.status === "connected"
    ? { kind: "integration", id: only.id }
    : { kind: "failing", id: only.id };
}

/**
 * Why memory is not served on this deployment, in one wording for both
 * audiences, told apart only by what follows: a run's refusal says what
 * happened to that run ("memory was not used"), the palette, before any run
 * exists, says what will happen ("runs go without memory"). The cause and the
 * fix are the same words in both. Without a full stop, because a screen that
 * quotes a refusal adds its own. `failure` is the connection's own message,
 * when it has one.
 */
export function memoryNotServedReason(
  problem:
    | { readonly kind: "ambiguous"; readonly names: readonly string[] }
    | { readonly kind: "failing"; readonly name: string; readonly failure?: string | undefined },
  audience: "run" | "deployment",
): string {
  const consequence = audience === "run" ? "so memory was not used" : "so runs go without memory";
  if (problem.kind === "ambiguous") {
    const { names } = problem;
    const listed =
      names.length === 2
        ? `${names[0]} and ${names[1]} both provide`
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} all provide`;
    return `${listed} memory on this deployment and no active provider is selected, ${consequence}. Disable all but one of them on the Integrations page`;
  }
  const failure = problem.failure ? ` (${problem.failure})` : "";
  return `${problem.name} is switched on for memory and its connection is failing${failure}, ${consequence}. Fix it on the Integrations page, or disable it there to use the built-in memory`;
}

/** The palette's sentence for the memory rule above, or null when runs here remember. */
function memoryIssue(integrations: DeploymentIntegrations): string | null {
  const choice = memoryProviderChoice(integrations.byId.values());
  if (choice.kind === "builtin" || choice.kind === "integration") return null;
  const nameOf = (id: string) => integrations.byId.get(id)?.name ?? id;
  const reason =
    choice.kind === "ambiguous"
      ? memoryNotServedReason({ kind: "ambiguous", names: choice.ids.map(nameOf) }, "deployment")
      : memoryNotServedReason(
          {
            kind: "failing",
            name: nameOf(choice.id),
            failure: integrations.byId.get(choice.id)?.failure?.message,
          },
          "deployment",
        );
  return `${reason}.`;
}

/** The capability as a sentence reads it, from the SDK's one table of labels. */
function capabilityLabel(capability: string): string {
  return (sdkCapabilityLabel(capability) ?? capability.replace(/_/g, " ")).toLowerCase();
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
 * Blocks that run an agent in a sandbox without touching the workspace. Every
 * agent sandbox is configured with every tracing provider (`agentTracingRun`,
 * called by `ensureAgentSandbox` in `blocks/agent-sandbox.ts`), so a
 * generic_agent whose workspace mode is "none" still reaches tracing. With a
 * workspace mode it touches the workspace and is covered by the rule below.
 */
const AGENT_SANDBOX_BLOCKS = new Set(["generic_agent"]);

/**
 * Blocks that read or write a ticket through the issue tracker.
 *
 * The ticket triggers make the whole run about a ticket, so they stand for
 * what every run they start reaches whatever its blocks are: the ticket is
 * read at dispatch (`dispatchTicket` in services/dispatch/dispatch.ts), moved
 * back to the backlog when the run fails and on to AI Review when it finishes
 * (`moveTicketStep`, through the run's `moveTargets` in agent-workflow.ts). A
 * plan approval continues a ticket's run (`dispatchPlanApproved` in
 * services/approvals/dispatch.ts). The rest call it themselves:
 * post_ticket_comment, send_plan_approval and update_ticket_status.
 */
const ISSUE_TRACKER_BLOCKS = new Set([
  "trigger_ticket_ai",
  "trigger_plan_approved",
  "post_ticket_comment",
  "send_plan_approval",
  "update_ticket_status",
]);

/**
 * Whether a block touches the run's workspace, from the rule the scheduler
 * already runs on (`workflowWorkspaceAccessOf` in @shared/workflow-graph), not
 * from a second list here: a block that starts touching the workspace is
 * counted the day it does, where a hand-kept list would silently lose its pins.
 *
 * Touching the workspace reaches three capabilities, because the workspace is
 * prepared on first use (`ensureWorkspace` in blocks/prepare-workspace, which
 * the agent blocks reach through `ensureCodeWorkspace`): version control, to
 * resolve and clone the repositories; agent tracing, because the sandbox is
 * configured with every tracing provider (`agentTracingRun`); and memory,
 * hydrated into the workspace (`hydrateWorkspaceMemoryStep`, seeded by
 * `seedRepoMemoryStep`) and captured back when the run tears it down
 * (`persistWorkspaceMemoryStep`). The set it answers for is wider than the
 * blocks that prepare it (a check or a leak review reads a workspace an
 * earlier block prepared), and that is harmless: such a block cannot run
 * without a prepared workspace, so its run reaches the same three anyway.
 */
function touchesWorkspace(type: string, params: Readonly<Record<string, unknown>> | undefined): boolean {
  const node = { type, configuration: params ?? {} } as unknown as WorkflowDefinitionV2Node;
  return workflowWorkspaceAccessOf(node) !== "none";
}

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
  if (touchesWorkspace(type, params)) {
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
    /** A stored definition's node carries its parameters here. */
    readonly configuration?: Readonly<Record<string, unknown>>;
    /** A runtime node carries the same parameters here. */
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
    // Every caller but the palette hands stored nodes, whose parameters are
    // `configuration`: reading only `params` saw none of them, so an
    // investigation that opted out of chat still pinned the chat provider.
    const parameters = node.configuration ?? node.params;
    for (const capability of coreBlockCapabilities(node.type, parameters).reached) {
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
