import { z } from "zod";
import type { TicketSummary } from "../../adapters/issue-tracker/types.js";
import type {
  RetrievalFailureReason,
  SlackSearchResult,
} from "../../lib/slack-search.js";
import { isRunControlError } from "../run-control-error.js";
import { resolveCallLlmTarget } from "./call-llm.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "./types.js";

const DEFAULT_SLACK_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CEILING = 10;
const MAX_KEYWORDS = 10;

/** Bound for one evidence snippet. Retrieval feeds a triage decision, so the
 *  opening of a ticket or the matched message is enough; the link carries the
 *  rest. Also the answer to "do not copy unrestricted conversation history into
 *  prompts": the prompt sees at most maxResults bounded snippets. */
const MAX_EXCERPT_CHARS = 500;

/** A template may contain nested clauses, but it must not close a parenthesis
 * it did not open. Otherwise an authored `) OR (project = OTHER` branch can
 * escape the configured project scope because JQL gives AND higher precedence
 * than OR. Parentheses inside quoted strings are data, not structure. */
function hasBalancedJqlStructure(clause: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < clause.length; index += 1) {
    const char = clause[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quoted;
}

export const paramsSchema = z
  .object({
    // A selection list, like the VCS providers on the PR triggers, rather than a
    // nested object: params are flat by contract (string | number | boolean |
    // string[]), and a shape the param type cannot hold would have to be cast
    // through every layer that touches it.
    providers: z
      .array(z.enum(["jira", "slack"]))
      .min(1)
      .default(["jira", "slack"]),
    slackChannels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    slackLookbackDays: z.number().int().min(1).max(365).optional(),
    jiraJqlTemplate: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(hasBalancedJqlStructure, "JQL template has unbalanced parentheses or quotes")
      .optional(),
    // Capped at the plan's ceiling rather than left open: every hit costs a
    // permalink call and a slice of the theory prompt, and ten pieces of
    // evidence per provider are already more than a human reads.
    maxResults: z.number().int().min(1).max(MAX_RESULTS_CEILING).optional(),
    model: z
      .string()
      .trim()
      .max(200)
      .regex(/^[A-Za-z0-9._:\/-]+$/)
      .optional(),
  })
  .strict();

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
  source: "jira" | "slack";
  title: string;
  excerpt: string;
  /** Reporter display name, or the Slack user id. */
  author: string;
  /** Jira project key, or the Slack channel id. */
  origin: string;
  /** ISO 8601, empty when the provider reports none. */
  timestamp: string;
  /** Stable link an operator can open. */
  link: string;
};

/**
 * Why some evidence is missing, per provider and (for Slack) per channel. The
 * companion to `partial`: `partial` says WHICH provider is incomplete, this says
 * why, so "the bot was never invited to #support" is distinguishable from "Slack
 * timed out" and from "searched, found nothing" (both lists empty).
 */
type RetrievalGap = {
  provider: "jira" | "slack";
  reason: RetrievalFailureReason;
  /** The Slack channel the gap is about, empty when the whole provider failed. */
  scope: string;
};

function truncateExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_EXCERPT_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_EXCERPT_CHARS)}…`;
}

/** Jira hit -> normalized evidence. Slack's ts is a unix seconds string, Jira's
 *  updated is already ISO, so only Slack needs converting. */
function jiraEvidence(ticket: TicketSummary): InvestigateEvidence {
  return {
    ref: `jira:${ticket.key}`,
    source: "jira",
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

function slackEvidence(
  match: SlackSearchResult["matches"][number],
): InvestigateEvidence {
  const text = truncateExcerpt(match.text);
  const seconds = Number.parseFloat(match.ts);
  return {
    ref: `slack:${match.channel}/${match.ts}`,
    source: "slack",
    // Slack messages have no title; the opening of the message is the closest
    // honest thing, and the excerpt carries the rest.
    title: text.length <= 80 ? text : `${text.slice(0, 80)}…`,
    excerpt: text,
    author: match.author,
    origin: match.channel,
    timestamp: Number.isFinite(seconds)
      ? new Date(seconds * 1000).toISOString()
      : "",
    link: match.permalink,
  };
}

/** Enabled providers, mirroring the dashboard's investigateProviders. An absent
 *  or unreadable list means both are on: the schema defaults it that way, and a
 *  node whose selection cannot be read should investigate everything rather than
 *  silently investigate nothing. */
function resolveProviders(raw: unknown): { jira: boolean; slack: boolean } {
  if (!Array.isArray(raw)) return { jira: true, slack: true };
  return { jira: raw.includes("jira"), slack: raw.includes("slack") };
}

function resolveSlackChannels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (channel): channel is string =>
      typeof channel === "string" && channel.trim() !== "",
  );
}

function jqlLiteral(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Compose the Jira query. The tenant's configured project is ANDed in FIRST and
 * unconditionally, so no combination of keywords or template can reach a project
 * the deployment was not configured for: an authored template narrows inside
 * that project and cannot widen past it (a template naming another project
 * yields an empty result set rather than that project's tickets).
 *
 * Keywords become an OR'd text clause. Both the template and the keywords are
 * optional, but the project scope never is — there is no unscoped form of this
 * query.
 */
export function buildInvestigateJql(
  projectKey: string,
  keywords: string[],
  template?: string,
): string {
  const clauses = [`project = "${jqlLiteral(projectKey)}"`];
  const authored = template?.trim() ?? "";
  if (authored !== "" && hasBalancedJqlStructure(authored)) clauses.push(authored);
  const keywordClause = keywords
    .map(jqlLiteral)
    .filter((keyword) => keyword !== "")
    .map((keyword) => `text ~ "${keyword}"`)
    .join(" OR ");
  if (keywordClause !== "") clauses.push(keywordClause);
  return clauses.map((clause) => `(${clause})`).join(" AND ");
}

const GAP_REASON_PROSE: Record<RetrievalFailureReason, string> = {
  permission: "no access",
  timeout: "timed out",
  unavailable: "unavailable",
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
        ? gap.provider === "jira"
          ? "Jira"
          : "Slack"
        : `Slack channel ${gap.scope}`;
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
  const { generateStructured } = await import("../../lib/llm.js");
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
  | { status: "failed"; reason: RetrievalFailureReason };

/**
 * Coarse class for a tracker error, from what the adapter actually throws: a
 * refused credential is somebody's configuration to fix, an abort is a timeout,
 * anything else is treated as an outage. The status code is read out of the
 * adapter's message because that is where it puts it; misreading it costs a
 * wrong label on a gap, never a wrong classification of the ticket.
 */
export function classifyJiraFailure(error: unknown): RetrievalFailureReason {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const status = /Jira API error: (\d{3})/.exec(
    error instanceof Error ? error.message : "",
  )?.[1];
  return status === "401" || status === "403" ? "permission" : "unavailable";
}

async function searchJiraProvider(input: {
  /** The one project this deployment may search. Resolved by the caller from the
   *  tenant configuration, never from block params. */
  projectKey: string;
  keywords: string[];
  template?: string;
  maxResults: number;
}): Promise<ProviderOutcome<TicketSummary[]>> {
  try {
    // Fail closed: with no configured project there is no scope to search
    // within, and searching every project the credential can reach is exactly
    // what must not happen.
    if (input.projectKey === "") return { status: "failed", reason: "permission" };
    const { createAdapters } = await import("../../lib/adapters.js");
    const { issueTracker } = createAdapters();
    if (typeof issueTracker.searchTicketSummaries !== "function") {
      // The configured tracker cannot serve summary search at all, which is a
      // capability gap rather than an outage, but reads the same to the caller:
      // no Jira evidence this run.
      return { status: "failed", reason: "unavailable" };
    }
    const value = await issueTracker.searchTicketSummaries(
      buildInvestigateJql(input.projectKey, input.keywords, input.template),
      input.maxResults,
    );
    return { status: "ok", value };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return { status: "failed", reason: classifyJiraFailure(err) };
  }
}

async function searchSlackProvider(input: {
  /** Bot token from the tenant configuration, resolved by the caller. */
  token: string | undefined;
  channels: string[];
  keywords: string[];
  lookbackDays: number;
  maxResults: number;
}): Promise<ProviderOutcome<SlackSearchResult>> {
  // Missing credentials or scope are configuration gaps, not clean searches:
  // nothing will change until somebody configures the token and channels.
  if (!input.token || input.channels.length === 0) {
    return { status: "failed", reason: "permission" };
  }
  try {
    const { searchSlackChannels, classifySlackFailure } = await import(
      "../../lib/slack-search.js"
    );
    try {
      const value = await searchSlackChannels({
        token: input.token,
        channels: input.channels,
        keywords: input.keywords,
        lookbackDays: input.lookbackDays,
        maxResults: input.maxResults,
        now: new Date(),
      });
      return { status: "ok", value };
    } catch (err) {
      if (isRunControlError(err)) throw err;
      return { status: "failed", reason: classifySlackFailure(err) };
    }
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
  jira: { keywords: string[]; template?: string; maxResults: number } | null;
  slack: {
    channels: string[];
    keywords: string[];
    lookbackDays: number;
    maxResults: number;
  } | null;
}): Promise<{ evidence: InvestigateEvidence[]; gaps: RetrievalGap[] }> {
  "use step";
  // Both providers' credentials and the Jira project scope come from here, one
  // read, so no block param can influence what either provider is allowed to
  // reach.
  const { env } = await import("../../../env.js");
  const [jira, slack] = await Promise.all([
    input.jira === null
      ? Promise.resolve<ProviderOutcome<TicketSummary[]>>({ status: "disabled" })
      : searchJiraProvider({
          ...input.jira,
          projectKey: env.JIRA_PROJECT_KEY?.trim() ?? "",
        }),
    input.slack === null
      ? Promise.resolve<ProviderOutcome<SlackSearchResult>>({ status: "disabled" })
      : searchSlackProvider({ ...input.slack, token: env.CHAT_SDK_SLACK_TOKEN }),
  ]);

  const evidence: InvestigateEvidence[] = [];
  const gaps: RetrievalGap[] = [];

  if (jira.status === "ok") evidence.push(...jira.value.map(jiraEvidence));
  if (jira.status === "failed") {
    gaps.push({ provider: "jira", reason: jira.reason, scope: "" });
  }

  if (slack.status === "ok") {
    evidence.push(...slack.value.matches.map(slackEvidence));
    for (const skip of slack.value.skipped) {
      gaps.push({ provider: "slack", reason: skip.reason, scope: skip.channel });
    }
  }
  if (slack.status === "failed") {
    gaps.push({ provider: "slack", reason: slack.reason, scope: "" });
  }

  const { redactConfiguredSecretsInText } = await import(
    "../../run-observability/sanitizer.js"
  );
  const { configuredReplaySecrets } = await import(
    "../../run-observability/configured-secrets.js"
  );
  const secrets = configuredReplaySecrets();
  return {
    evidence: evidence.map((item) => ({
      ...item,
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
  const { generateStructured } = await import("../../lib/llm.js");
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
 * call, Jira and Slack are searched with them (each provider degrades
 * independently into the partial list), and a second LLM call turns ticket +
 * evidence into a classification and theory for a downstream human decision.
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

  const providers = resolveProviders(block.params.providers);
  const maxResults =
    typeof block.params.maxResults === "number"
      ? block.params.maxResults
      : DEFAULT_MAX_RESULTS;
  const slackLookbackDays =
    typeof block.params.slackLookbackDays === "number"
      ? block.params.slackLookbackDays
      : DEFAULT_SLACK_LOOKBACK_DAYS;
  const jiraJqlTemplate =
    typeof block.params.jiraJqlTemplate === "string" &&
    block.params.jiraJqlTemplate.trim() !== ""
      ? block.params.jiraJqlTemplate
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
    // project scope is NOT decided here: the step reads it from the tenant's
    // configuration, so no param can widen it.
    const searchJira =
      providers.jira && (keywords.length > 0 || jiraJqlTemplate !== undefined);
    const slackChannels = providers.slack
      ? resolveSlackChannels(block.params.slackChannels)
      : [];

    const retrieval = await blockInvestigateRetrievalStep({
      jira: searchJira
        ? {
            keywords,
            ...(jiraJqlTemplate === undefined ? {} : { template: jiraJqlTemplate }),
            maxResults,
          }
        : null,
      slack:
        providers.slack
          ? {
              channels: slackChannels,
              keywords,
              lookbackDays: slackLookbackDays,
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
