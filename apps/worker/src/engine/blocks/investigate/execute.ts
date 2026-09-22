import { z } from "zod";
import type { TicketSummary } from "../../../adapters/issue-tracker/types.js";
import type {
  MessageRetrievalFailure,
  MessageSearchMatch,
  MessageSearchOutcome,
} from "../../../adapters/messaging/types.js";
import type { Adapters } from "../../support/adapters.js";
import { isRunControlError } from "../../helpers/run-control-error.js";
import { resolveCallLlmTarget } from "../call-llm/execute.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "../support/types.js";

const DEFAULT_CHAT_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_RESULTS = 10;
const MAX_KEYWORDS = 10;

/** Bound for one evidence snippet. Retrieval feeds a triage decision, so the
 *  opening of a ticket or the matched message is enough; the link carries the
 *  rest. Also the answer to "do not copy unrestricted conversation history into
 *  prompts": the prompt sees at most maxResults bounded snippets. */
const MAX_EXCERPT_CHARS = 500;

/** The verdicts the theory call may return. insufficient_data is among them on
 *  purpose: with no evidence and a vague ticket, "I cannot tell" is the honest
 *  answer and routes to a human, where guessing false_positive would close a
 *  real bug. The block also emits it without asking, for a ticket with no text
 *  at all. */
const CLASSIFICATIONS = [
  "false_positive",
  "known_issue",
  "real_bug",
  "feature_request",
  "question",
  "insufficient_data",
] as const;

const KEYWORDS_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    keywords: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["keywords"],
  additionalProperties: false,
});

const THEORY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    classification: { type: "string", enum: CLASSIFICATIONS },
    theory: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
  },
  required: ["classification", "theory", "evidenceRefs"],
  additionalProperties: false,
});

const keywordsResultSchema = z.object({ keywords: z.array(z.string()) });
const theoryResultSchema = z.object({
  classification: z.enum(CLASSIFICATIONS),
  theory: z.string(),
  evidenceRefs: z.array(z.string()),
});

/**
 * One piece of evidence, normalized across providers so a downstream agent,
 * branch, transform, or human-approval block binds to the same paths whichever
 * provider produced it. A type alias rather than an interface on purpose: block
 * outputs must be assignable to JsonValue, which anonymous object types satisfy
 * structurally and interfaces do not.
 *
 * Every field is always present, empty when the provider does not report it.
 * `ref` is the stable identifier the theory prompt cites through evidenceRefs.
 */
type InvestigateEvidence = {
  ref: string;
  source: "issue_tracker" | "chat";
  title: string;
  excerpt: string;
  /** Reporter display name, or the chat user id. */
  author: string;
  /** Issue tracker project key, or the chat channel id. */
  origin: string;
  /** ISO 8601, empty when the provider reports none. */
  timestamp: string;
  /** Stable link an operator can open. */
  link: string;
};

/**
 * Why some evidence is missing, per source and, for chat, per channel. The
 * companion to `partial`: `partial` says WHICH source is incomplete, this
 * says why, so "the bot was never invited to #support" is distinguishable from
 * "the provider timed out" and from "searched, found nothing" (both lists
 * empty).
 */
type RetrievalGap = {
  provider: "issue_tracker" | "chat";
  reason: MessageRetrievalFailure;
  /** The channel the gap is about, empty when the whole source failed. */
  scope: string;
};

function truncateExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_EXCERPT_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_EXCERPT_CHARS)}…`;
}

/** Issue tracker hit -> normalized evidence. Chat's ts is a unix seconds
 *  string, the tracker's updated is already ISO, so only chat needs
 *  converting. */
function trackerEvidence(ticket: TicketSummary): InvestigateEvidence {
  return {
    ref: `issue_tracker:${ticket.key}`,
    source: "issue_tracker",
    title: `${ticket.key} ${ticket.summary}`.trim(),
    excerpt: truncateExcerpt(
      ticket.status === "" ? ticket.excerpt : `[${ticket.status}] ${ticket.excerpt}`,
    ),
    author: ticket.reporter,
    origin: ticket.project,
    timestamp: ticket.updatedAt,
    link: ticket.url,
  };
}

function chatEvidence(match: MessageSearchMatch): InvestigateEvidence {
  const text = truncateExcerpt(match.text);
  return {
    ref: `chat:${match.channel}/${match.id}`,
    source: "chat",
    // Chat messages have no title; the opening of the message is the closest
    // honest thing, and the excerpt carries the rest.
    title: text.length <= 80 ? text : `${text.slice(0, 80)}…`,
    excerpt: text,
    author: match.author,
    origin: match.channel,
    timestamp: match.postedAt,
    link: match.url,
  };
}

/**
 * Enabled sources, mirroring the dashboard's investigateSources. Accepts both
 * the capability vocabulary (`issue_tracker`, `chat`) and the old provider
 * vocabulary (`jira`, `slack`), because a run suspended before the rename
 * replays a recorded plan built with the old words: without this tolerance
 * that run would resume investigating nothing. An absent or unreadable list
 * means both are on: the schema defaults it that way, and a node whose
 * selection cannot be read should investigate everything rather than silently
 * investigate nothing.
 */
function resolveSources(raw: unknown): { issueTracker: boolean; chat: boolean } {
  if (!Array.isArray(raw)) return { issueTracker: true, chat: true };
  return {
    issueTracker: raw.includes("issue_tracker") || raw.includes("jira"),
    chat: raw.includes("chat") || raw.includes("slack"),
  };
}

function resolveChatChannels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (channel): channel is string =>
      typeof channel === "string" && channel.trim() !== "",
  );
}

const GAP_REASON_PROSE: Record<MessageRetrievalFailure, string> = {
  permission: "no access",
  timeout: "timed out",
  unavailable: "unavailable",
  // The deployment has a messaging provider that cannot search, or none at
  // all. Neither is an error: the investigation says what it could not read
  // and reasons from what it has.
  unsupported: "this deployment's messaging provider cannot search messages",
  not_connected: "no messaging provider is connected",
};

/**
 * The gaps as one sentence for a human, empty when nothing was missed. Says
 * "not searched" rather than "found nothing": the whole point is that absence of
 * evidence here is not evidence of absence.
 */
export function describeRetrievalGaps(gaps: readonly RetrievalGap[]): string {
  if (gaps.length === 0) return "";
  const parts = gaps.map((gap) => {
    const where =
      gap.scope === ""
        ? gap.provider === "issue_tracker"
          ? "the issue tracker"
          : "chat"
        : `chat channel ${gap.scope}`;
    return `${where} (${GAP_REASON_PROSE[gap.reason]})`;
  });
  return `Not searched: ${parts.join("; ")}.`;
}

function buildKeywordsPrompt(
  identifier: string,
  title: string,
  description: string,
): string {
  return [
    "You extract search keywords from an issue tracker ticket so similar tickets and chat discussions can be found.",
    "",
    `Ticket ${identifier}`,
    `Summary: ${title}`,
    "Description:",
    description,
    "",
    `Produce up to ${MAX_KEYWORDS} short keywords or phrases that best capture this ticket's problem area. Produce them in English AND in the ticket's own language when it differs from English, so retrieval matches discussions in either language.`,
  ].join("\n");
}

function buildTheoryPrompt(input: {
  identifier: string;
  title: string;
  description: string;
  evidence: InvestigateEvidence[];
}): string {
  return [
    "You are triaging an issue tracker ticket. Classify it from the ticket and the collected evidence, and explain your reasoning.",
    "",
    `Ticket ${input.identifier}`,
    `Summary: ${input.title}`,
    "Description:",
    input.description,
    "",
    "Collected evidence (JSON; each item has a stable ref):",
    JSON.stringify(input.evidence, null, 2),
    "",
    "Classify the ticket as exactly one of:",
    "- false_positive: not an actual problem (noise, misunderstanding, already resolved).",
    "- known_issue: the evidence shows this is already reported or discussed.",
    "- real_bug: a genuine defect that warrants a code fix.",
    "- feature_request: asks for new functionality rather than reporting a defect.",
    "- question: asks for an answer, not a code change.",
    "",
    "Return the classification, a concise theory explaining it for a human deciding whether to proceed, and evidenceRefs listing the refs of the evidence items the theory relies on.",
  ].join("\n");
}

async function blockInvestigateKeywordsStep(input: {
  model: string;
  provider?: "claude" | "codex";
  prompt: string;
}): Promise<string[]> {
  "use step";
  const { generateStructured } = await import("../../llm.js");
  const result = await generateStructured({ ...input, schema: KEYWORDS_SCHEMA });
  const parsed = keywordsResultSchema.safeParse(result.object);
  if (!parsed.success) {
    throw new Error("LLM keyword output did not match the requested schema");
  }
  return parsed.data.keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== "")
    .slice(0, MAX_KEYWORDS);
}
blockInvestigateKeywordsStep.maxRetries = 0;

type ProviderOutcome<T> =
  | { status: "disabled" }
  | { status: "ok"; value: T }
  | { status: "failed"; reason: MessageRetrievalFailure };

/**
 * Coarse class for a tracker error, from what the adapter actually throws: a
 * refused credential is somebody's configuration to fix, an abort is a timeout,
 * anything else is treated as an outage.
 *
 * This is a weak signal: the port (`IssueTrackerAdapter`) does not carry typed
 * errors, so all this has to go on is the message text. It matches a 401 or
 * 403 appearing as a standalone number anywhere in the message rather than one
 * provider's exact wording, so a differently worded permission error still
 * classifies. The cost of getting it wrong either way is the same: a
 * permission failure may be reported to the run as merely "unavailable",
 * which reads as an outage rather than something the tenant's connection
 * needs fixed.
 */
export function classifyTrackerFailure(error: unknown): MessageRetrievalFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const message = error instanceof Error ? error.message : "";
  const permission = /(?<![0-9])(401|403)(?![0-9])/.test(message);
  return permission ? "permission" : "unavailable";
}

async function searchTrackerSource(adapters: Adapters, input: {
  keywords: string[];
  template?: string;
  maxResults: number;
}): Promise<ProviderOutcome<TicketSummary[]>> {
  try {
    const { issueTracker } = adapters;
    if (typeof issueTracker.findTickets !== "function") {
      // The configured tracker cannot serve keyword search at all, which is a
      // capability gap rather than an outage, but reads the same to the
      // caller: no tracker evidence this run.
      return { status: "failed", reason: "unavailable" };
    }
    const value = await issueTracker.findTickets({
      keywords: input.keywords,
      limit: input.maxResults,
      ...(input.template ? { providerQuery: input.template } : {}),
    });
    return { status: "ok", value };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return { status: "failed", reason: classifyTrackerFailure(err) };
  }
}

/**
 * What people said, through the `messaging` capability.
 *
 * The capability answers rather than throws, and a provider that cannot search
 * at all is one of its answers, so this block never has to know which chat
 * product a deployment uses or whether it has one.
 */
async function searchChatProvider(adapters: Adapters, input: {
  channels: string[];
  keywords: string[];
  lookbackDays: number;
  maxResults: number;
}): Promise<ProviderOutcome<Extract<MessageSearchOutcome, { ok: true }>>> {
  // No channels named is a configuration gap, not a clean search: nothing will
  // change until somebody names one.
  if (input.channels.length === 0) return { status: "failed", reason: "permission" };
  try {
    const outcome = await adapters.messaging.searchMessages({
      channels: input.channels,
      keywords: input.keywords,
      lookbackDays: input.lookbackDays,
      maxResults: input.maxResults,
    });
    return outcome.ok
      ? { status: "ok", value: outcome }
      : { status: "failed", reason: outcome.reason };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return { status: "failed", reason: "unavailable" };
  }
}

/**
 * Search both providers concurrently and return normalized evidence plus the
 * gaps. Normalization and secret redaction happen HERE rather than in the
 * caller: this step's return value is durable run state, so raw provider bodies
 * must never leave it.
 *
 * A null side means the provider is off for this node, which produces no
 * evidence AND no gap: not searching is not the same as failing to search.
 */
async function blockInvestigateRetrievalStep(input: {
  issueTracker: { keywords: string[]; template?: string; maxResults: number } | null;
  chat: {
    channels: string[];
    keywords: string[];
    lookbackDays: number;
    maxResults: number;
  } | null;
}): Promise<{ evidence: InvestigateEvidence[]; gaps: RetrievalGap[] }> {
  "use step";
  // The issue tracker scopes its own search from its connection; no block
  // param can widen what it is allowed to reach. The chat side has no
  // credential to fetch: it goes through the messaging capability, which
  // resolves whichever provider this deployment connected.
  // One bundle for both sources. Each `await createAdapters()` opens a run registry
  // connection, and two searches in one step asking twice is a connection
  // nobody needed.
  const { createAdapters } = await import("../../support/adapters.js");
  const adapters = await createAdapters();
  const [issueTracker, chat] = await Promise.all([
    input.issueTracker === null
      ? Promise.resolve<ProviderOutcome<TicketSummary[]>>({ status: "disabled" })
      : searchTrackerSource(adapters, input.issueTracker),
    input.chat === null
      ? Promise.resolve<ProviderOutcome<Extract<MessageSearchOutcome, { ok: true }>>>({
          status: "disabled",
        })
      : searchChatProvider(adapters, input.chat),
  ]);

  const evidence: InvestigateEvidence[] = [];
  const gaps: RetrievalGap[] = [];

  if (issueTracker.status === "ok") evidence.push(...issueTracker.value.map(trackerEvidence));
  if (issueTracker.status === "failed") {
    gaps.push({ provider: "issue_tracker", reason: issueTracker.reason, scope: "" });
  }

  if (chat.status === "ok") {
    evidence.push(...chat.value.matches.map(chatEvidence));
    for (const skip of chat.value.skipped) {
      gaps.push({ provider: "chat", reason: skip.reason, scope: skip.channel });
    }
  }
  if (chat.status === "failed") {
    gaps.push({ provider: "chat", reason: chat.reason, scope: "" });
  }

  const { redactConfiguredSecretsInText } = await import(
    "../../../run-observability/sanitizer.js"
  );
  const { configuredReplaySecrets } = await import(
    "../../../run-observability/configured-secrets.js"
  );
  const secrets = configuredReplaySecrets();
  return {
    evidence: evidence.map((item) => Object.assign({}, item, {
      title: redactConfiguredSecretsInText(item.title, secrets),
      excerpt: redactConfiguredSecretsInText(item.excerpt, secrets),
    })),
    gaps,
  };
}
blockInvestigateRetrievalStep.maxRetries = 0;

async function blockInvestigateTheoryStep(input: {
  model: string;
  provider?: "claude" | "codex";
  prompt: string;
}): Promise<z.infer<typeof theoryResultSchema>> {
  "use step";
  const { generateStructured } = await import("../../llm.js");
  const result = await generateStructured({ ...input, schema: THEORY_SCHEMA });
  const parsed = theoryResultSchema.safeParse(result.object);
  if (!parsed.success) {
    throw new Error("LLM theory output did not match the requested schema");
  }
  return parsed.data;
}
blockInvestigateTheoryStep.maxRetries = 0;

/**
 * investigate: retrieval-augmented ticket triage. Keywords come from one LLM
 * call, the issue tracker and chat are searched with them (each source
 * degrades independently into the partial list), and a second LLM call turns
 * ticket + evidence into a classification and theory for a downstream human
 * decision.
 * The block never mutates the ticket: the graph must terminate every path with
 * a ticket mutation or human_question, otherwise the trigger poller reruns
 * this block on every poll.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
): Promise<BlockExecutionResult> => {
  const title = ctx.ticket.title.trim();
  const description = ctx.ticket.description.trim();
  if (title === "" && description === "") {
    return {
      kind: "next",
      output: {
        status: "ok",
        classification: "insufficient_data",
        theory:
          "Ticket has neither a summary nor a description; there is nothing to investigate.",
        evidence: [],
        partial: [],
        partialReasons: [],
      },
    };
  }

  // Every param falls back to its pre-rename name: a recorded plan from
  // before this rename hands the block the old words, and a definition the
  // one-off rewrite has not reached still stores them (see
  // RENAMED_WORKFLOW_BLOCK_PARAMS in @shared/contracts).
  const sources = resolveSources(block.params.sources ?? block.params.providers);
  const maxResults =
    typeof block.params.maxResults === "number"
      ? block.params.maxResults
      : DEFAULT_MAX_RESULTS;
  const chatChannelsParam = block.params.chatChannels ?? block.params.slackChannels;
  const chatLookbackDaysParam =
    block.params.chatLookbackDays ?? block.params.slackLookbackDays;
  const chatLookbackDays =
    typeof chatLookbackDaysParam === "number"
      ? chatLookbackDaysParam
      : DEFAULT_CHAT_LOOKBACK_DAYS;
  const issueTrackerQueryTemplateParam =
    block.params.issueTrackerQueryTemplate ?? block.params.jiraJqlTemplate;
  const issueTrackerQueryTemplate =
    typeof issueTrackerQueryTemplateParam === "string" &&
    issueTrackerQueryTemplateParam.trim() !== ""
      ? issueTrackerQueryTemplateParam
      : undefined;
  const { provider, model } = resolveCallLlmTarget(
    block.params,
    ctx.runDefaultKind,
    ctx.defaults,
  );

  try {
    const keywords = await blockInvestigateKeywordsStep({
      model,
      ...(provider !== undefined ? { provider } : {}),
      prompt: buildKeywordsPrompt(ctx.ticket.identifier, title, description),
    });

    // Nothing to look for means no search at all, which is not a gap. The
    // project scope is NOT decided here: the tracker source scopes its own
    // search from its connection, so no param can widen it.
    const searchTracker =
      sources.issueTracker &&
      (keywords.length > 0 || issueTrackerQueryTemplate !== undefined);
    const chatChannels = sources.chat ? resolveChatChannels(chatChannelsParam) : [];

    const retrieval = await blockInvestigateRetrievalStep({
      issueTracker: searchTracker
        ? {
            keywords,
            ...(issueTrackerQueryTemplate === undefined
              ? {}
              : { template: issueTrackerQueryTemplate }),
            maxResults,
          }
        : null,
      chat:
        sources.chat
          ? {
              channels: chatChannels,
              keywords,
              lookbackDays: chatLookbackDays,
              maxResults,
            }
          : null,
    });

    const { evidence, gaps } = retrieval;
    // One entry per incomplete provider, whether the provider failed outright or
    // only some of its channels did.
    const partial = [...new Set(gaps.map((gap) => gap.provider))];

    const theoryResult = await blockInvestigateTheoryStep({
      model,
      ...(provider !== undefined ? { provider } : {}),
      prompt: buildTheoryPrompt({
        identifier: ctx.ticket.identifier,
        title,
        description,
        evidence,
      }),
    });

    // The gaps go into the prose too, not only the structured field: the human
    // deciding on this theory usually reads it through human_question, which
    // renders the theory and nothing else.
    const gapNote = describeRetrievalGaps(gaps);
    const theory =
      gapNote === "" ? theoryResult.theory : `${theoryResult.theory}\n\n${gapNote}`;

    return {
      kind: "next",
      output: {
        status: "ok",
        classification: theoryResult.classification,
        theory,
        evidence,
        partial,
        partialReasons: gaps,
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }
};
