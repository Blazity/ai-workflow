/** * What the Integrations screens say, as data rather than as markup.
 *
 * Every sentence an admin reads about an integration is decided here, so the
 * card, the connection screen and their tests read one description instead of
 * three. Nothing here decides a STATUS: the worker's resolver owns that, and
 * these functions only turn the state it returned into words. If a sentence
 * would need a fact the API does not carry, it does not get written.
 */
import type {
  IntegrationCapabilityDto,
  IntegrationConnectionFieldDto,
  IntegrationDto,
  IntegrationFailure,
  IntegrationImpactPreviewRequest,
  IntegrationImpactPreviewResponse,
  IntegrationState,
  IntegrationVerification,
  SystemHealthResponse,
} from "@shared/contracts";
import type { IntegrationConnectionSaveRequest } from "@shared/contracts";
import { INTEGRATION_PROVIDER_WAIT_MS } from "@shared/contracts";

import { capabilityLabel as sdkCapabilityLabel } from "@integrations/registry";
import { formatDateTime } from "@/lib/date-time";

/** The chip tones the cockpit already ships, named by what they mean here. */
export type IntegrationTone = "success" | "failed" | "quiet" | "off";

export interface IntegrationStatusChip {
  readonly label: string;
  readonly tone: IntegrationTone;
}

/**
 * The chip, read off `status` and never off `connection`: an integration a
 * human switched off says Disabled even though its credentials are perfect,
 * because that is the answer to "why is nothing running".
 */
export function statusChip(state: IntegrationState): IntegrationStatusChip {
  switch (state.status) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "failing":
      return { label: "Failing", tone: "failed" };
    case "disabled":
      return { label: "Disabled", tone: "off" };
    default:
      return { label: "Not connected", tone: "quiet" };
  }
}

/**
 * Where the values in use come from.
 *
 * A source that cannot serve the integration says so rather than claiming the
 * values came from it: "values come from the environment" on a deployment whose
 * environment sets nothing is the sentence that sends an admin to look for
 * variables that were never the problem.
 */
function sourceLine(state: IntegrationState): string {
  if (state.source === "environment") {
    if (state.environment.complete) {
      return "Values come from this deployment's environment variables.";
    }
    const missing = state.environment.missingVariables;
    return missing.length === 0
      ? "The source is this deployment's environment, which does not configure it."
      : `The source is this deployment's environment, which does not configure it: ${andList(missing)} ${missing.length === 1 ? "is" : "are"} not set.`;
  }
  return state.stored.activeVersion === null
    ? "The source is the values stored here, and none of them has passed its test yet."
    : "Values come from what was stored here.";
}

/**
 * What the last test proved.
 *
 * `never_tested` deliberately has no time and no apology: a deployment
 * configured through its environment is connected because its values are
 * complete, and every deployment alive today is in that state.
 */
export function verificationLine(verification: IntegrationVerification): string {
  switch (verification.state) {
    case "passed":
      return `The provider accepted these values on ${formatDateTime(verification.at)}.`;
    case "failed":
      return `The last test failed on ${formatDateTime(verification.at)}.`;
    case "stale":
      return `Tested on ${formatDateTime(verification.at)}, before these values changed, so that answer says nothing about what is in use now.`;
    default:
      return "Nothing has ever tested these values against the provider.";
  }
}

/** Longer than any sentence a person reads on a status line. */
const PROVIDER_SENTENCE_MAX = 240;

/**
 * Text from outside this product, made safe to put on a line an admin reads.
 *
 * A provider that answers 401 with a sign-in page hands us a couple of kilobytes
 * of HTML, and a forwarded worker error can carry a stack trace and the worker's
 * own URL. Both were rendered whole: the status line became a wall, and an
 * internal hostname reached the browser. So: first line only, which drops a
 * stack; tags and absolute URLs removed; whitespace collapsed; length bounded.
 *
 * The worker stores the same text on the connection, so a card reloaded from
 * the database is bounded here too rather than at the write. Bounding it at the
 * write as well is S2's to decide.
 */
export function readableProviderText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const flattened = firstLine
    .replace(/<[^>]*>/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, "a URL")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length === 0) return "The provider answered, and said nothing this screen can show.";
  return flattened.length > PROVIDER_SENTENCE_MAX
    ? `${flattened.slice(0, PROVIDER_SENTENCE_MAX - 1).trimEnd()}…`
    : flattened;
}

/** Outside text made readable, and ended as a sentence. */
function sentence(text: string): string {
  return readableProviderText(text).replace(/\s*\.?$/, ".");
}

/** The provider's own sentence, plus the names an admin has to go and set. */
function failureLine(failure: IntegrationFailure): string {
  const missingVariables = failure.missingVariables ?? [];
  const missingFields = failure.missingFields ?? [];
  const parts = [sentence(failure.message)];
  if (missingVariables.length > 0) {
    parts.push(`Not set here: ${andList(missingVariables)}.`);
  }
  if (missingFields.length > 0) {
    parts.push(`Left empty: ${andList(missingFields)}.`);
  }
  return parts.join(" ");
}

/** "a", "a and b", "a, b and c". */
export function andList(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

/**
 * Whether the editor can actually run one block, read from the same registry
 * the palette is built from. Absent when that read did not answer.
 */
export type BlockAvailability = ReadonlyMap<
  string,
  { readonly available: boolean; readonly unavailableReason: string | null }
>;

/**
 * That answer, taken from the editor's own block registry and narrowed to the
 * blocks these integrations declare.
 *
 * Narrowed on purpose: the registry holds every block this build has, and the
 * only question this screen asks is about the handful an integration brings.
 * A block the registry does not carry gets no entry rather than a refusal: an
 * integration nobody has connected contributes nothing to the palette yet, and
 * the card's job there is to say what connecting would bring.
 */
export function blockAvailabilityOf(
  registry: Record<string, { readonly availability: { available: boolean; unavailableReason: string | null } }>,
  integrations: readonly IntegrationDto[],
): BlockAvailability {
  const map = new Map<string, { available: boolean; unavailableReason: string | null }>();
  for (const integration of integrations) {
    for (const block of integration.blocks) {
      const contract = registry[block.type];
      if (!contract) continue;
      map.set(block.type, {
        available: contract.availability.available,
        unavailableReason: contract.availability.unavailableReason,
      });
    }
  }
  return map;
}

/**
 * What connecting this integration adds, in the order an author meets it: the
 * blocks they would drag onto a canvas, then the screens, then the capability
 * other blocks would be able to use.
 *
 * A block an integration declares is not automatically a block this build can
 * run: core may still own the capability it needs, and the palette says so.
 * This card said "adds two blocks" while the palette refused one of them, so
 * the promise is now made from the palette's own answer and never from the
 * manifest alone. Without that answer the card describes and does not promise.
 *
 * That answer is only read while the integration is in use. An integration
 * nobody connected has every block refused for that reason alone ("Demo is not
 * connected"), which hides whatever the build would say once it is, and turns
 * the one card whose job is to say what connecting brings into a list of
 * circular refusals. So: in use, the palette is talking about this build; not
 * in use, the status line above already says why, and the card describes.
 */
export function unlocksLines(
  integration: IntegrationDto,
  paletteAnswer?: BlockAvailability,
): string[] {
  const availability = integration.state.usable ? paletteAnswer : undefined;
  const lines: string[] = [];
  if (integration.blocks.length > 0) {
    if (!availability) {
      lines.push(
        `Brings the ${andList(integration.blocks.map((block) => block.label))} ${
          integration.blocks.length === 1 ? "block" : "blocks"
        }; the workflow editor says which of them this build can run.`,
      );
    } else {
      const runnable = integration.blocks.filter(
        (block) => availability.get(block.type)?.available !== false,
      );
      const refused = integration.blocks.filter(
        (block) => availability.get(block.type)?.available === false,
      );
      if (runnable.length > 0) {
        lines.push(
          `Adds the ${andList(runnable.map((block) => block.label))} ${
            runnable.length === 1 ? "block" : "blocks"
          } to the workflow editor.`,
        );
      }
      for (const block of refused) {
        const reason = availability.get(block.type)?.unavailableReason;
        lines.push(
          reason
            ? `${block.label} stays unavailable in the editor: ${readableProviderText(reason)}`
            : `${block.label} stays unavailable in the editor.`,
        );
      }
    }
  }
  if (integration.pages.length > 0) {
    lines.push(
      `Adds the ${andList(integration.pages.map((page) => page.label))} ${
        integration.pages.length === 1 ? "screen" : "screens"
      }.`,
    );
  }
  if (integration.capabilities.length > 0) {
    lines.push(
      `Serves the ${andList(integration.capabilities.map((id) => capabilityLabel(id).toLowerCase()))} ${
        integration.capabilities.length === 1 ? "capability" : "capabilities"
      }.`,
    );
  }
  if (lines.length === 0) lines.push("Adds no blocks, screens or capabilities.");
  return lines;
}

/**
 * A capability id as a person reads it: the SDK's one label, or, for an id a
 * newer worker added, the id's words, which is at least what that worker calls
 * it.
 */
function capabilityLabel(id: string): string {
  const known = sdkCapabilityLabel(id);
  if (known) return known;
  const words = id.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The heading of one capability row: the label the worker sent, which names a
 * capability even a newer worker added, or this build's own for a worker from
 * before the overview carried labels.
 */
export function capabilityHeading(capability: IntegrationCapabilityDto): string {
  const sent: string | undefined = capability.label;
  return sent || capabilityLabel(capability.id);
}

/** How many providers a capability takes at once, in a few words. */
export function capabilityCardinalityLine(capability: IntegrationCapabilityDto): string {
  return capability.cardinality === "one"
    ? "One provider at a time"
    : "Every connected provider at once";
}

/**
 * Who serves one capability, as the worker decided it.
 *
 * Two usable providers of a one-provider capability are said as a choice
 * nobody made, because the engine uses neither: saying "served by the first"
 * would describe a deployment that does not exist. Nothing serving it names
 * who could, because "nothing provides messaging" in front of an admin who can
 * see Slack below sends them looking for a provider they already have.
 */
export function capabilityServingLine(
  capability: IntegrationCapabilityDto,
  nameOf: (id: string) => string,
): string {
  const serving = capability.serving;
  const names = (ids: readonly string[]) => andList(ids.map(nameOf));
  switch (serving.kind) {
    case "integrations":
      return `Served by ${names(serving.ids)}.`;
    case "builtin":
      return `Served by ${serving.name}, which is part of AI Workflow.`;
    case "ambiguous":
      return serving.ids.length === 2
        ? `${names(serving.ids)} both provide it and none is chosen, so neither is used. Until this page can choose, switch off the one you do not want.`
        : `${names(serving.ids)} all provide it and none is chosen, so none of them is used. Until this page can choose, switch off the ones you do not want.`;
    case "refused":
      // The resolver's sentence names the provider and what to do, so it is
      // said whole rather than wrapped in a second naming of the same one.
      return `Nothing serves it: ${sentence(serving.reason)}`;
    case "unknown":
      return `Who serves it could not be worked out: ${readableProviderText(serving.reason)}`;
    default:
      return capability.declaredBy.length === 0
        ? "Nothing in this build provides it."
        : `Nothing serves it yet. ${names(capability.declaredBy)} can, once connected below.`;
  }
}

/**
 * What a built-in provider is, said where an integration would show its
 * connection. It has no values, no test and no switch, so the card says why
 * rather than showing an empty form.
 */
export function builtinProviderLines(
  capability: IntegrationCapabilityDto,
  nameOf: (id: string) => string,
): string[] {
  const replacements = capability.declaredBy;
  return [
    "It ships with AI Workflow and keeps its data in this deployment's own database, so there is nothing to connect.",
    // Said by name, because "an integration that provides it" sent a
    // first-time admin scrolling the cards for one this build does not ship.
    replacements.length === 0
      ? "No integration in this build can replace it."
      : `Connecting ${andList(replacements.map(nameOf))} below replaces it.`,
  ];
}

/**
 * Why the capability rows are missing. A worker from before the overview
 * answers 404, and reloading does nothing until that worker is deployed; any
 * other failure is worth a reload.
 */
export type CapabilitiesUnread = "older_worker" | "unreadable";

export function capabilitiesUnreadLine(reason: CapabilitiesUnread): string {
  return reason === "older_worker"
    ? "This worker does not report which provider serves each capability yet; it will once the worker is deployed with this page. The integrations below are unaffected."
    : "Which provider serves each capability could not be read just now. The integrations below are unaffected; reload in a moment.";
}

/**
 * Whether anything is stored here for this integration right now.
 *
 * Read off the values the worker reported, never off `stored.latestVersion`.
 * That counter is the highest version ever minted and the token a save
 * carries, so a disconnect, which erases every value in every version, leaves
 * it where it was: read as presence, it kept offering Disconnect for erased
 * values and told the admin that what was stored had not passed a test.
 */
export function storesValues(integration: IntegrationDto): boolean {
  return integration.fields.some(
    (field) => field.storedValue !== undefined || field.storedSecretSet,
  );
}

/**
 * The lines under an integration's name: where its values come from, what the
 * last test proved, and why it is not usable when it is not.
 *
 * Ordered by what an admin does next. A refusal comes first because it is the
 * only line that asks for an afternoon; the rest is context for it.
 */
export function statusDetailLines(
  integration: IntegrationDto,
  /** The last stored health scan, when this role could read one. */
  scan: SystemHealthResponse | null = null,
): string[] {
  const state = integration.state;
  const lines: string[] = [];
  const disagreement = scanDisagreementLine(integration, scan);
  if (disagreement) lines.push(disagreement);

  if (state.status === "disabled") {
    lines.push(
      `Turned off here on purpose. Its blocks stay in the workflow editor, greyed out and saying why, and a run that reaches one fails naming ${integration.name}.`,
    );
  }
  if (state.failure) lines.push(failureLine(state.failure));
  const webhook = webhookLine(integration);
  if (webhook) lines.push(webhook);

  const neverConfigured =
    state.connection === "not_connected" &&
    state.environment.setVariables.length === 0 &&
    !storesValues(integration);

  if (neverConfigured) {
    const required = integration.fields.filter((field) => !field.optional);
    lines.push(
      required.length === 0
        ? "Nothing configures it on this deployment yet."
        : `Nothing configures it on this deployment yet. It needs its ${andList(required.map((field) => field.label))}.`,
    );
  } else {
    lines.push(sourceLine(state));
  }

  if (state.connection !== "not_connected") {
    lines.push(verificationLine(state.verification));
  }

  const prepared = state.stored.prepared;
  if (prepared) {
    lines.push(
      `Values saved on ${formatDateTime(prepared.at)} did not pass their test and are not in use: ${failureLine(prepared.failure)}`,
    );
  }
  return lines;
}

/**
 * What the card says about a webhook served on part of the connection, when
 * its answer differs from the rest of the integration: answered while the rest
 * is not usable (Slack's slash command on its signing secret alone), refused
 * while the rest is Connected. The worker decided `served` with the read the
 * webhook route makes; this only words it, and says nothing when the two
 * agree, since the status above already said it.
 */
function webhookLine(integration: IntegrationDto): string | null {
  const { webhook, state } = integration;
  if (!webhook || state.status === "disabled") return null;
  const needs = webhook.requires.map(
    (key) => integration.fields.find((field) => field.key === key)?.label ?? key,
  );
  if (webhook.served && !state.usable) {
    const rest = integration.capabilities.map((id) => capabilityLabel(id).toLowerCase());
    return `The ${webhook.label} is still answered here: it needs only the ${andList(needs)}. Everything else ${integration.name} does${rest.length > 0 ? ` (${andList(rest)})` : ""} waits until the rest of the connection works.`;
  }
  if (!webhook.served && state.usable) {
    return `The ${webhook.label} is not answered here: it needs the ${andList(needs)}, which ${needs.length === 1 ? "is" : "are"} not set or cannot be read.`;
  }
  return null;
}

/**
 * Whether a source's panel may say "in use": only when that source is the one
 * selected AND it configures something. A deployment that never configured an
 * integration reads the environment by default, and "Environment variables ·
 * in use" there claimed a connection nobody made.
 */
export function sourceInUse(state: IntegrationState, source: "environment" | "stored"): boolean {
  if (state.source !== source) return false;
  return source === "environment"
    ? state.environment.setVariables.length > 0
    : state.stored.activeVersion !== null;
}

/**
 * What the Availability section says instead of its switch, or null when the
 * switch is the truth. An integration that is switched on and not connected
 * cannot be used by any workflow, so a switch reading "Workflows may use it"
 * there is false; switched off, the switch stays, since turning it back on is
 * a real choice.
 */
export function availabilityInsteadOfSwitch(integration: IntegrationDto): string | null {
  const { state } = integration;
  if (!state.enabled || state.connection !== "not_connected") return null;
  return `Not connected, so no workflow can use ${integration.name} yet. The switch to turn it off appears once it is connected.`;
}

/**
 * The line under Availability when nothing is stored to disconnect.
 */
export function nothingToDisconnectLine(integration: IntegrationDto): string {
  return sourceInUse(integration.state, "environment")
    ? "This connection lives in the deployment's environment variables, so it is changed by changing them and switched off with the control above."
    : `There is nothing to disconnect: nothing configures ${integration.name} on this deployment yet.`;
}

/**
 * What a card says when the latest health scan disagrees with it.
 *
 * Decision (QA, Arthur on production): the card's status is the resolver's,
 * from the values in use and the last connection test, and it stays so; a
 * health probe is a separate, later or earlier, observation. When the card
 * says Connected and the last scan found the integration down, degraded or
 * misconfigured, the card says so in one line, naming the scan's time and its
 * first failing check, rather than silently reading green beside a red Health
 * page. The other way round (card failing, probe live) says nothing: the
 * card's failure already names its reason and the fix.
 */
export function scanDisagreementLine(
  integration: IntegrationDto,
  scan: SystemHealthResponse | null,
): string | null {
  if (!scan || integration.state.status !== "connected") return null;
  const entry = scan.integrations.find((candidate) => candidate.id === integration.id);
  if (!entry || !(entry.mode in SCAN_DISAGREES)) return null;
  const failing = entry.checks.find((check) => check.mode in SCAN_DISAGREES && check.message);
  const why = failing ? ` (${failing.label}: ${readableProviderText(failing.message!)})` : "";
  return `The health scan of ${formatDateTime(scan.generatedAt)} found ${integration.name} ${
    SCAN_DISAGREES[entry.mode as keyof typeof SCAN_DISAGREES]
  }${why}. The status here comes from the values in use and the last test; press Test to check again.`;
}

const SCAN_DISAGREES = {
  down: "down",
  degraded: "degraded",
  misconfigured: "in need of configuration",
} as const;

/**
 * The hint under a connection field.
 *
 * A secret is write-only, so the field never pretends to hold one: it says
 * whether a value is stored and what leaving it blank will do. Without
 * `INTEGRATION_SECRETS_KEY` the field cannot accept anything at all, and
 * saying so before a value is typed is the difference between a rejected form
 * and a wasted afternoon.
 */
export function fieldHint(
  field: IntegrationConnectionFieldDto,
  state: IntegrationState,
  clearing: boolean,
): string {
  const environment = field.envSet
    ? `${field.env} is set on this deployment.`
    : `${field.env} is not set on this deployment.`;
  // What the field is comes first for a secret too: "Nothing is stored yet"
  // alone left the admin guessing which token, from where.
  const withDescription = (sentence: string) =>
    [field.description, sentence, environment].filter(Boolean).join(" ");
  if (!field.secret) return [field.description, environment].filter(Boolean).join(" ");
  if (!state.secretsKeyAvailable) {
    return withDescription("It cannot be stored here until INTEGRATION_SECRETS_KEY is set, see above.");
  }
  if (clearing) return withDescription("The stored value will be removed when this is saved.");
  if (field.storedSecretSet) {
    return withDescription("A value is stored. Leave this blank to keep it, or type a new one to replace it.");
  }
  return withDescription("Nothing is stored yet. What you type is encrypted and never shown again.");
}

/** Where SETUP.md explains the key stored secrets are encrypted with. */
export const SECRETS_KEY_SETUP_URL =
  "https://github.com/Blazity/ai-workflow/blob/main/SETUP.md#integration-secrets";

/**
 * What the connection screen says when this deployment cannot store a secret
 * (no `INTEGRATION_SECRETS_KEY`), or null when it can or the integration has no
 * secret. `blocksSave` is true when a required secret has no stored value and
 * its field is locked: a save could only fail, so the button is off and this
 * sentence says why.
 */
export function secretsKeyNotice(
  integration: IntegrationDto,
): { readonly text: string; readonly blocksSave: boolean } | null {
  if (integration.state.secretsKeyAvailable) return null;
  const secrets = integration.fields.filter((field) => field.secret);
  if (secrets.length === 0) return null;
  const blocked = secrets.filter((field) => !field.optional && !field.storedSecretSet);
  const text =
    "Secrets cannot be stored from this page yet: this deployment has no INTEGRATION_SECRETS_KEY, the key that encrypts the credentials saved here. An admin sets it on the deployment (see Integration secrets in SETUP.md)" +
    (blocked.length > 0
      ? `, and until then ${integration.name} needs its ${andList(blocked.map((field) => field.label))} from the deployment's environment variables.`
      : ".");
  return { text, blocksSave: blocked.length > 0 };
}

export interface ConnectionFormInput {
  readonly fields: readonly IntegrationConnectionFieldDto[];
  /** What the inputs hold right now, keyed by field key. */
  readonly values: Readonly<Record<string, string>>;
  /** Secret fields the admin explicitly asked to empty. */
  readonly clearedSecrets: readonly string[];
  readonly state: IntegrationState;
}

/**
 * The required fields this form would send nothing for.
 *
 * Checked in the browser so an admin is told which field is empty before a
 * credential leaves the page, and checked again by the worker, which is what
 * actually enforces it. A required secret counts as supplied when one is
 * already stored and this save is not clearing it: that is what lets an admin
 * correct a URL without retyping a token.
 */
export function missingRequiredFields(input: ConnectionFormInput): string[] {
  return input.fields
    .filter((field) => !field.optional)
    .filter((field) => {
      const typed = (input.values[field.key] ?? "").trim();
      if (typed.length > 0) return false;
      if (!field.secret) return true;
      if (input.clearedSecrets.includes(field.key)) return true;
      return !field.storedSecretSet;
    })
    .map((field) => field.label);
}

/**
 * Why testing what is in use would prove nothing, or null when there is
 * something to ask the provider.
 *
 * "Test what is in use" tests the connection a run would take, so with nothing
 * configured there is no request to make. Sent anyway, the worker built one out
 * of empty values, the `new URL("")` that threw arrived here as "the provider
 * is not answering, try again in a moment", and that non-answer was written
 * down as a failed verification. Nothing was tried, so the page says so rather
 * than sending, and nobody spends an afternoon on a provider that was never
 * asked. The classification of that throw is the worker's own bug and is not
 * fixed from here.
 */
export function testRefusal(integration: IntegrationDto): string | null {
  const state = integration.state;
  if (state.connection !== "not_connected") return null;
  const nothing = `Nothing is configured for ${integration.name}, so there is nothing to test.`;
  const save = "Fill the values in above and save, which tests them against the provider.";
  if (state.source === "environment") {
    const missing = state.environment.missingVariables;
    return missing.length > 0
      ? `${nothing} ${andList(missing)} ${missing.length === 1 ? "is" : "are"} not set on this deployment. Set ${missing.length === 1 ? "it" : "them"} there, or fill the values in above and save, which tests them.`
      : `${nothing} ${save}`;
  }
  if (storesValues(integration)) {
    return `Nothing ${integration.name} could be tested with is in use: what is stored here has not passed a test, so no run uses it. Correct the values above and save again, which tests them.`;
  }
  return `${nothing} ${save}`;
}

/** Said while the provider is being asked, because the wait is long enough to
 *  look like nothing happening. The number is the worker's own budget. */
export function waitingOnProviderLine(integration: IntegrationDto): string {
  return `Asking ${integration.name} now. It has ${INTEGRATION_PROVIDER_WAIT_MS / 1000} seconds to answer, and nothing on this page changes until it does.`;
}

/**
 * The body a save sends.
 *
 * Non-secret fields travel as they are shown, so what an admin reads on the
 * screen is what gets stored. A secret travels only when one was typed: an
 * untouched secret field carries no placeholder to send, and emptying one is
 * `clearSecrets`, which is an action rather than a blank input.
 */
export function buildSaveRequest(
  input: ConnectionFormInput,
): IntegrationConnectionSaveRequest {
  const values: Record<string, string> = {};
  const clearSecrets: string[] = [];
  for (const field of input.fields) {
    const typed = (input.values[field.key] ?? "").trim();
    if (!field.secret) {
      values[field.key] = typed;
      continue;
    }
    if (input.clearedSecrets.includes(field.key)) {
      clearSecrets.push(field.key);
      continue;
    }
    if (typed.length > 0) values[field.key] = typed;
  }
  return {
    expectedVersion: input.state.stored.latestVersion,
    values,
    clearSecrets,
  };
}

/**
 * What the provider said about a save or a test, in the state the worker
 * returned with it.
 *
 * Values that failed their test are stored and not used, so the sentence after
 * the refusal is about what is running right now: a previously working
 * connection carries on, and a deployment that had none is still not connected.
 * Both facts come from the state the response carried, never from a guess made
 * here.
 */
/** A Test of what is in use on a deployment reading its environment did not try
 *  what is typed in the form, so it says which values failed. */
const ENVIRONMENT_TEST_FAILED_LINE =
  "What failed is this deployment's environment variables, not the values typed above. Change them on the deployment, or fill the values in above and save to use those instead.";

export function testOutcomeLines(
  test: { readonly ok: true; readonly message?: string } | { readonly ok: false; readonly failure: IntegrationFailure },
  integration: IntegrationDto,
  /** Which button produced this, because the advice is not the same. */
  origin: "save" | "test",
): string[] {
  if (test.ok) {
    // A save on a deployment whose environment already connects the
    // integration stores and tests the values and leaves the source alone
    // (the worker never takes over a working environment). "Accepted" alone
    // read as "in use", and an admin who then revoked the old credential
    // stopped every run.
    if (origin === "save" && integration.state.source === "environment") {
      const lines = [
        `${integration.name} accepted these values. They are stored and tested, and not in use: runs still use this deployment's environment variables.`,
      ];
      if (test.message) lines.push(readableProviderText(test.message));
      lines.push(
        "To use them, choose Use the stored values below, which first shows what the switch would interrupt. Keep the old credential until then.",
      );
      return lines;
    }
    const lines = [`${integration.name} accepted these values.`];
    if (test.message) lines.push(readableProviderText(test.message));
    return lines;
  }
  const lines = [failureLine(test.failure)];
  if (test.failure.reason === "provider_unreachable") {
    lines.push(
      origin === "save"
        ? "That is the provider not answering, not the credential being refused. The values are stored and will be used once a test passes; try again in a moment."
        : "That is the provider not answering, not the credential being refused, so the connection is as it was; try again in a moment.",
    );
  }
  const state = integration.state;
  // A Test of stored values that are in use, which the provider refused (or
  // one of which cannot be sent at all), turns the connection Failing: those
  // values are what every run sends. Said before the generic advice, which
  // would tell this admin nothing changed.
  if (origin === "test" && state.source === "environment" && state.connection === "failing") {
    // The same stop as for stored values: the environment's variables are
    // what every run sends. Saying only "change them on the deployment" left
    // out that runs have already stopped.
    lines.push(
      `These are the values in use, and ${integration.name} refused them: the integration is now Failing, and runs that need it stop until the variables are corrected and a later Test passes.`,
      ENVIRONMENT_TEST_FAILED_LINE,
    );
    return lines;
  }
  if (origin === "test" && state.source === "stored" && state.connection === "failing") {
    lines.push(
      test.failure.reason === "value_malformed"
        ? "These are the values in use, and one of them cannot be sent as it is: the integration is now Failing, and runs that need it stop until corrected values are saved."
        : `These are the values in use, and ${integration.name} refused them: the integration is now Failing, and runs that need it stop until new values are saved or a later Test passes.`,
    );
    return lines;
  }
  if (state.connection === "connected") {
    lines.push(
      origin === "save"
        ? "These values are stored but not in use: the connection that was already working carries on untouched."
        : "Nothing changed: a test that fails changes no value.",
    );
    return lines;
  }
  // A test of what is in use, on a deployment reading its environment, did not
  // try what is typed above: telling that admin to correct the fields and save
  // again sends them to edit values nothing is reading.
  lines.push(
    origin === "test" && state.source === "environment"
      ? ENVIRONMENT_TEST_FAILED_LINE
      : "Nothing was activated, so the integration is still not connected. Correct the values above and save again.",
  );
  return lines;
}

/**
 * What turning the kill switch does, said before it is thrown, beside the
 * measured cost (`integrationImpactLines` with `"disable"`): which enabled
 * workflows reach the integration and how many runs in flight stop.
 */
export function disableConsequence(integration: IntegrationDto): string[] {
  const name = integration.name;
  // Said about blocks only when there are some: Jira has none, and "Jira's
  // blocks grey out" sent an admin looking for blocks that do not exist.
  return [
    ...(integration.blocks.length > 0
      ? [
          `${name}'s blocks grey out in the workflow editor at once, each carrying the reason, and publishing a workflow that uses one is refused.`,
        ]
      : []),
    `${capitalized(inFlightWithout(integration))} A step already running finishes.`,
    "Nothing stored is touched, so enabling it again finds exactly these values.",
  ];
}

export function enableConsequence(integration: IntegrationDto): string {
  // Where the values come from: an integration read from the environment has
  // nothing stored to go back to.
  const values =
    integration.state.source === "environment"
      ? "this deployment's environment variables"
      : "the values stored for it";
  return integration.blocks.length > 0
    ? `${integration.name} goes back to ${values}, and its blocks return to the workflow editor.`
    : `${integration.name} goes back to ${values}, and workflows may use it again.`;
}

/**
 * What disconnecting does, which is two different afternoons.
 *
 * With a complete environment the connection falls back to it and the
 * deployment keeps working; without one, everything that uses the integration
 * stops. The page knows which case it is in, so it does not offer one warning
 * for both.
 */
export function disconnectConsequence(integration: IntegrationDto): string[] {
  const lines = [
    `Every value stored for ${integration.name}, and every stored secret in every past version, is erased. Who saved what, and when, is kept.`,
  ];
  if (integration.state.environment.complete) {
    lines.push(
      integration.state.enabled
        ? `This deployment's environment configures ${integration.name}, so it goes back to those values and keeps working.`
        : `This deployment's environment configures ${integration.name}, so it goes back to those values. It stays switched off here, so nothing runs until it is enabled again.`,
    );
  } else {
    lines.push(
      integration.blocks.length > 0
        ? `Nothing else on this deployment configures ${integration.name}, so it becomes Not connected: its blocks grey out in the editor and runs that need it fail until it is connected again.`
        : `Nothing else on this deployment configures ${integration.name}, so it becomes Not connected: runs that need it fail until it is connected again.`,
    );
  }
  return lines;
}

const IMPACT_NAME_LIMIT = 5;

/** Said in a confirmation while its impact is being read. */
export const READING_IMPACT_LINE =
  "Reading enabled workflows and runs in flight before anything changes.";

/** The four changes decision 9 asks the impact of before they are made: the
 *  contract's own list, so a preview added there is a case every table below
 *  has to answer. */
export type IntegrationImpactAction = IntegrationImpactPreviewRequest["preview"];

/**
 * Why runs in flight may stop, or do not, for one change. The first line of
 * every confirmation, because it is the answer to "what does this break".
 * Every sentence follows the worker's `stops`; none decides it again.
 *
 * Save and a switch of source are only ever confirmed when runs may stop or
 * the read failed (the screen goes ahead otherwise), so they have no sentence
 * for "nothing stops": a second-guess of a case nobody sees is how "both
 * sources hold the same connection" came to be said about two different
 * tokens.
 */
function impactReasonLine(
  integration: IntegrationDto,
  impact: IntegrationImpactPreviewResponse | null,
  action: IntegrationImpactAction,
): string {
  const name = integration.name;
  if (impact === null) {
    switch (action) {
      case "save":
        return `The worker could not determine whether these values change the connection runs already in flight are using. If they do, a run that checks the one it started with may stop at its next use of ${name} instead of following the edit.`;
      case "disconnect":
        return `The worker could not determine what disconnecting leaves. If nothing else configures ${name}, ${inFlightWithout(integration)}`;
      case "source":
        return `The worker could not determine whether the two sources hold the same connection. If they differ, a run that checks the one it started with may stop at its next use of ${name}.`;
      case "disable":
        return `Turning ${name} off is read at every use, so ${inFlightWithout(integration)}`;
    }
  }
  switch (impact.stops) {
    case "none":
      // A run's pin covers the non-secret values only, so matching values
      // say nothing about the token behind them.
      if (!integration.state.usable) {
        return `${name} is not working right now, so no run in flight is using it and this stops none.`;
      }
      return integration.fields.some((field) => field.secret)
        ? `This deployment's environment configures ${name} with the same non-secret values, so disconnecting stops no run in flight. Runs go on with the environment's secrets, which may not be the ones stored here.`
        : `This deployment's environment configures ${name} with the same values, so disconnecting stops no run in flight.`;
    case "unusable":
      return action === "disable"
        ? `Turning ${name} off is read at every use, so ${inFlightWithout(integration)}`
        : `Nothing else configures ${name} after this, so ${inFlightWithout(integration)}`;
    case "reconfigured": {
      const change =
        action === "save"
          ? `If ${name} accepts these values, the connection changes.`
          : `This changes the values ${name} is used with.`;
      const paths = pinCheckPaths(integration);
      return paths.length === 0
        ? `${change} Nothing a run does with ${name} compares the connection it started with, so a run in flight follows the change.`
        : `${change} A run in flight that uses ${andList(paths)} checks the connection it started with, and may stop at its next use of ${name}.`;
    }
  }
}

/**
 * Where a run compares the connection it pinned for this integration, which is
 * where a changed connection stops it: the integration's own blocks, the Send
 * message block for a messaging provider, a repository on a version control
 * provider. The tracker and memory compare nothing today, and tracing compares
 * its pin only to stop tracing that run, never the run itself (the worker's
 * `runsThatMayStop` counts by the same list).
 */
function pinCheckPaths(integration: IntegrationDto): string[] {
  const paths: string[] = [];
  if (integration.blocks.length > 0) paths.push(`${integration.name}'s own blocks`);
  if (integration.capabilities.includes("messaging")) paths.push("a Send message block");
  if (integration.capabilities.includes("vcs")) paths.push(`a repository on ${integration.name}`);
  return paths;
}

/**
 * How the list of enabled workflows is introduced. A workflow reaches a
 * version control provider through the repository it picks for each ticket,
 * so the worker lists every workflow whose repository scope leaves room for
 * the provider (`definitionMayReach` in the worker's impact.ts): whether the
 * next run of an unscoped workflow lands on this provider or another is not
 * knowable before the ticket arrives, and "may use" is the claim the list can
 * back. Every other reach is read off the graph, and is certain.
 */
function workflowsUsing(integration: IntegrationDto): string {
  return integration.capabilities.includes("vcs")
    ? `Enabled workflows that may use ${integration.name}`
    : `Enabled workflows using ${integration.name}`;
}

/** "that uses its issue tracker", or "that uses it" for one with no capability. */
/**
 * What a run in flight does once the integration is gone, capability by
 * capability, as the end of a sentence. Tracing never stops a run (it goes on
 * untraced) and memory never does (it goes on without memory, and says why);
 * everything else a run needs from the integration, its blocks included, fails
 * the run naming it at its next use. "May stop, or go on without it" was true
 * of neither case and contradicted the line beside it.
 */
function inFlightWithout(integration: IntegrationDto): string {
  const name = integration.name;
  const stopping = [
    ...(integration.blocks.length > 0 ? [`${name}'s blocks`] : []),
    ...integration.capabilities
      .filter((id) => !(id in GOES_ON_WITHOUT))
      .map((id) => `its ${capabilityLabel(id).toLowerCase()}`),
  ];
  const goingOn = integration.capabilities
    .filter((id) => id in GOES_ON_WITHOUT)
    .map((id) => GOES_ON_WITHOUT[id as keyof typeof GOES_ON_WITHOUT]);
  if (stopping.length === 0 && goingOn.length === 0) {
    return `a run in flight that uses ${name} fails naming it at its next use.`;
  }
  const stops = `a run in flight that uses ${andList(stopping)} fails naming ${name} at its next use of it.`;
  if (goingOn.length === 0) return stops;
  const continues = `a run in flight goes on ${andList(goingOn)}, and is not stopped.`;
  if (stopping.length === 0) return continues;
  return `${stops} Losing only the rest never stops a run: it goes on ${andList(goingOn)}.`;
}

/** The capabilities whose loss a run rides out, and how it goes on. */
const GOES_ON_WITHOUT = {
  agent_tracing: "untraced",
  memory: "without memory",
} as const;

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The measured cost shown before a connection change. Null is an unread fact,
 * never an empty fact, so every unknown has its own sentence.
 */
function repositoriesLine(
  integration: IntegrationDto,
  repositories: IntegrationImpactPreviewResponse["repositories"] | null,
): string {
  if (repositories === null) {
    return "Affected repositories: unknown. The worker could not read the repository catalog.";
  }
  if (repositories.length === 0) return `Repositories using ${integration.name}: none.`;
  const shown = repositories.slice(0, IMPACT_NAME_LIMIT).map(({ path }) => path);
  const remainder = repositories.length - shown.length;
  return `Repositories using ${integration.name}: ${shown.join(", ")}${
    remainder > 0 ? `, and ${remainder} more` : ""
  }.`;
}

export function integrationImpactLines(
  integration: IntegrationDto,
  impact: IntegrationImpactPreviewResponse | null,
  action: IntegrationImpactAction,
): string[] {
  const lines = [impactReasonLine(integration, impact, action)];
  const definitions = impact?.enabledDefinitions ?? null;
  const repositories = impact?.repositories ?? null;
  // Repositories belong to a version control provider; "Repositories using
  // Jira: none" read as a finding about Jira.
  if (integration.capabilities.includes("vcs")) lines.push(repositoriesLine(integration, repositories));
  const unmeasured = impact?.unmeasuredCapabilities ?? [];
  if (definitions === null && unmeasured.length > 0) {
    lines.push(
      `${workflowsUsing(integration)}: unknown. This preview cannot yet see which workflows use its ${andList(
        unmeasured.map((id) => capabilityLabel(id).toLowerCase()),
      )}, so it names none rather than claim none.`,
    );
  } else if (definitions === null) {
    lines.push("Enabled workflows: unknown. The worker could not read the deployed definitions.");
  } else if (definitions.length === 0) {
    lines.push(
      `${workflowsUsing(integration)}: none. Drafts and disabled workflows are not included.`,
    );
  } else {
    const shown = definitions.slice(0, IMPACT_NAME_LIMIT).map(({ name }) => name);
    const remainder = definitions.length - shown.length;
    lines.push(
      `${workflowsUsing(integration)}: ${shown.join(", ")}${
        remainder > 0 ? `, and ${remainder} more` : ""
      }.`,
    );
  }
  const runs = impact?.inFlightRuns ?? null;
  lines.push(
    runs === null && unmeasured.length > 0
      ? "Runs in flight that may stop: unknown, for the same reason, so this confirmation does not claim zero."
      : runs === null
      ? "Runs in flight that may stop: unknown. The worker could not measure them, so this confirmation does not claim zero."
      : runs === 1
        ? "1 run in flight may stop."
        : `${runs} runs in flight may stop.`,
  );
  return lines;
}

const CONFIRM_LABELS: Record<
  IntegrationImpactAction,
  { readonly unknown: string; readonly go: string }
> = {
  save: { unknown: "Save with unknown impact", go: "Save the configuration" },
  disconnect: { unknown: "Erase values with unknown impact", go: "Erase the stored values" },
  source: { unknown: "Switch with unknown impact", go: "Switch the source" },
  disable: { unknown: "Turn it off with unknown impact", go: "Turn it off" },
};

/** The confirm button says what pressing it may cost, or that nobody could tell. */
export function integrationImpactConfirmLabel(
  impact: IntegrationImpactPreviewResponse | null,
  action: IntegrationImpactAction,
): string {
  const labels = CONFIRM_LABELS[action];
  const runs = impact?.inFlightRuns ?? null;
  if (runs === null) return labels.unknown;
  if (runs === 0) return labels.go;
  return `${labels.go}, ${runs} ${runs === 1 ? "run" : "runs"} may stop`;
}

/**
 * Why the connection cannot be handed to the other source yet, or null when it
 * can. Read off the presence the API reported, never off a status the browser
 * worked out for itself; the worker refuses the same switch with the same
 * reason.
 */
export function sourceSwitchRefusal(
  integration: IntegrationDto,
  target: IntegrationState["source"],
): string | null {
  const { environment, stored } = integration.state;
  if (target === integration.state.source) return "This is already the source in use.";
  if (target === "environment") {
    if (environment.complete) return null;
    return environment.missingVariables.length > 0
      ? `This deployment's environment does not configure ${integration.name}: ${andList(environment.missingVariables)} ${environment.missingVariables.length === 1 ? "is" : "are"} not set.`
      : `This deployment's environment does not configure ${integration.name}.`;
  }
  if (stored.activeVersion === null) {
    // Saved and never activated is not the same as never saved: telling an
    // admin who is looking at "saved 1 time, none of it in use" that nothing is
    // stored is the contradiction that makes a screen untrustworthy. Nor is
    // erased the same as saved, which is why this reads the values.
    return storesValues(integration)
      ? "What is stored here has not passed a test, so nothing can be switched to it. Correct the values above and save again."
      : "Nothing is stored here yet. Fill the values in and save them first; they are tested before anything switches over.";
  }
  return stored.complete
    ? null
    : `The stored values leave ${andList(stored.missingFields)} empty.`;
}

/** Said when a second tab, or a second admin, saved first. */
export function versionConflictLine(integration: IntegrationDto): string {
  return `Somebody else changed ${integration.name} while this page was open, so nothing here was saved. What you typed is still below, next to the values as they are now. Save again to apply it.`;
}

/** A value read back to an admin: one line, bounded, and never a secret. */
function quotedValue(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "empty";
  return flat.length > 80 ? `"${flat.slice(0, 79)}…"` : `"${flat}"`;
}

/**
 * What saving again would overwrite, after a conflict re-read the connection.
 *
 * The 409 says only which version won, so the page re-reads the integration and
 * compares field by field. Fields nobody touched here are taken from that read;
 * these lines are the ones that are still different, so "Save again" is a choice
 * between two named values rather than a second blind write. A secret has no
 * readable value, so it is described by what saving would do to the stored one.
 */
export function conflictDifferenceLines(input: ConnectionFormInput): string[] {
  const lines: string[] = [];
  for (const field of input.fields) {
    const typed = (input.values[field.key] ?? "").trim();
    if (!field.secret) {
      const current = (field.storedValue ?? "").trim();
      if (typed !== current) {
        lines.push(`${field.label} is now ${quotedValue(current)} here, and you typed ${quotedValue(typed)}.`);
      }
      continue;
    }
    if (input.clearedSecrets.includes(field.key) && field.storedSecretSet) {
      lines.push(`${field.label}: a value is stored here now, and saving erases it.`);
      continue;
    }
    if (typed.length > 0) {
      lines.push(
        field.storedSecretSet
          ? `${field.label}: a value is stored here now, and saving replaces it with the one you typed.`
          : `${field.label}: nothing is stored here now, and saving stores the one you typed.`,
      );
    }
  }
  if (lines.length === 0) {
    lines.push("Nothing you typed differs from the values now in place, so saving again changes nothing.");
  }
  return lines;
}

/**
 * Said when this page stopped following the server so it would not empty the
 * form under somebody's hands.
 */
export const CHANGED_ELSEWHERE_LINE =
  "Somebody else changed this integration while you were typing. What you typed is untouched, and everything else on this page is from before their change. Save to apply yours and anything that differs is shown first; reload to start from what is stored now.";

/** Said when the conflict could not be turned into a comparison. */
export const CONFLICT_REREAD_FAILED_LINE =
  "The values as they are now could not be read back, so there is nothing to compare what you typed against. Reload the page before saving again.";

/** What the page says while this build ships nothing to connect. */
export const NO_INTEGRATIONS_LINE =
  "This build ships no integrations yet. Everything this deployment talks to is still configured through its environment variables, and each provider gets a card here as it becomes an integration.";

/** What the core ticket-to-PR flow needs, in capabilities rather than names. */
export const CORE_CAPABILITIES_LINE =
  "The ticket-to-PR flow needs an issue tracker and version control; the coding agents it runs are set up as harness profiles, not here. Blocks that need a capability nobody provides stay unavailable in the editor and say which one is missing.";

/**
 * Why a page an integration contributes is not being shown, or null when it is.
 *
 * An integration's own pages read the provider through the connection, so an
 * integration nobody has connected has nothing for them to show. Rather than
 * run its code and let it produce whatever a package makes of a connection it
 * does not have, the area says what is missing in the cockpit's words and
 * leaves the Connection tab, which is the action, one click away.
 *
 * `usable` is the resolver's own answer, so this reads it rather than working
 * the same thing out again from `enabled` and `connection`.
 */
function contributedPageBlockedLine(integration: IntegrationDto): string | null {
  const state = integration.state;
  if (state.usable) return null;
  if (!state.enabled) {
    return `${integration.name} is switched off, so its pages are not being shown. The Connection tab is where it goes back on.`;
  }
  if (state.connection === "failing") {
    return `${integration.name}'s connection is failing, so its pages have nothing to read. The Connection tab says what went wrong.`;
  }
  return `${integration.name} is not connected, so its pages have nothing to read yet. The Connection tab is where that starts.`;
}

/** Enough of a manifest to decide what an area shows: name and declared pages. */
export interface ContributedPageManifest {
  readonly name: string;
  readonly pages: readonly { readonly id: string; readonly label: string }[];
}

export type ContributedPageOutcome =
  /** Hand the integration's own component the page. */
  | { readonly kind: "render"; readonly label: string }
  /** Say something in our own words, and offer the one thing that helps. */
  | {
      readonly kind: "notice";
      readonly title: string;
      readonly body: string;
      readonly action: "integration" | "connection";
    };

/**
 * What the area shows behind a tab, before any integration code runs.
 *
 * Four different nothings, and the difference matters to whoever arrived here
 * from a bookmark, a link or a tab they left open: a page this integration does
 * not have, a page it declares that this build did not compile, an integration
 * that is not in use, and the page itself. A bare 404 collapses the four into
 * one and sends people looking in the wrong place.
 *
 * A worker that did not answer is a fourth kind of nothing, not a licence to
 * carry on. The rule this page follows is that an integration's own code runs
 * only once the deployment has said the integration is in use, and "we could
 * not ask" is not that sentence: an integration somebody disabled an hour ago
 * would otherwise start running again the moment the worker went quiet. The
 * notice names our outage rather than the integration, because that is whose
 * fault it is.
 */
export function contributedPageOutcome({
  manifest,
  pageId,
  hasComponent,
  integration,
  workerAnswered = true,
}: {
  manifest: ContributedPageManifest;
  pageId: string;
  hasComponent: boolean;
  integration?: IntegrationDto;
  /** False when the worker did not answer, which is not the same as absent. */
  workerAnswered?: boolean;
}): ContributedPageOutcome {
  const declared = manifest.pages.find((page) => page.id === pageId);
  if (!declared) {
    const has =
      manifest.pages.length === 0
        ? "no pages"
        : andList(manifest.pages.map((page) => page.label));
    return {
      kind: "notice",
      title: "No page under that name",
      body: `${manifest.name} contributes ${has}, and nothing called "${pageId}". The tabs above are everything this integration has.`,
      action: "integration",
    };
  }
  if (!hasComponent) {
    // The generator refuses a declared page with no component, so this means
    // the manifest and the dashboard entry were built from different commits.
    return {
      kind: "notice",
      title: "This page did not ship",
      body: `${manifest.name} declares ${declared.label}, and this build carries no screen for it. The build is inconsistent with the integration; re-running the registry generator is what fixes it.`,
      action: "integration",
    };
  }
  if (!integration) {
    return {
      kind: "notice",
      title: declared.label,
      body: workerAnswered
        ? `This deployment does not ship ${manifest.name} any more, so there is nothing behind this page.`
        : `Whether ${manifest.name} is connected could not be read just now, and its pages are only shown once this deployment says it is in use. Reload in a moment.`,
      action: "connection",
    };
  }
  const blocked = contributedPageBlockedLine(integration);
  if (blocked) {
    return { kind: "notice", title: declared.label, body: blocked, action: "connection" };
  }
  return { kind: "render", label: declared.label };
}

/** Said to a role that may read this page and not change it. */
export const MEMBER_READ_ONLY_LINE =
  "Read-only: every integration and its status are shown here, and connecting or changing one needs the owner or admin role.";

/** Said when the worker did not answer at all. */
export function workerUnreachableLine(canManage: boolean): string {
  return canManage
    ? "The worker did not answer, so nothing can be shown or changed here. Check the worker on the System health page and reload."
    : "The worker did not answer, so nothing can be shown here. Ask an owner or admin to check the worker, then reload.";
}
