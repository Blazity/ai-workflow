/**
 * An Agent Briefing: what one send gave a model, as stored and as served.
 *
 * Three readers depend on one shape: the worker stores it, the dashboard
 * renders it and MCP pages through it, so the page and the tool can never tell
 * two stories about the same send. Every schema here is a READER's schema:
 * never `.strict()`, open slugs for every set that can grow, because the worker
 * and the dashboard deploy separately and a reader older than the writer must
 * still open the record.
 *
 * WHAT WAS SENT, NOT WHAT IS TRUE NOW. Every field records what the send put in
 * front of the model, taken from the inputs the renderers used. Nothing is
 * re-read from the catalog at capture or at read time.
 *
 * TWO LOSSES, NEVER MERGED. `cutBeforeSend` on a part is text removed before
 * the model saw it (`cutCause` says by what): it changes what the agent got.
 * `truncatedForStorage` is text our storage budget did not keep: it changes
 * only what we can show. A reader that merged them would blame the agent for
 * ignoring text it was never given, or the other way round.
 *
 * The briefing is not the model's whole context window: the harness CLI adds
 * its own system prompt, tool definitions and the instruction files it finds in
 * the checkout. Only what we sent is recorded.
 */
import { z } from "zod";
import type { WorkScopeActor, WorkScopeEntry } from "@shared/contracts";
import {
  AGENT_BRIEFING_CONTEXT_MAX_BYTES,
  AGENT_BRIEFING_MAX_BUDGET_BYTES,
  AGENT_BRIEFING_PARTS_PER_SECTION_MAX,
  AGENT_BRIEFING_PROVENANCE_MAX,
  AGENT_BRIEFING_RELATIONSHIPS_MAX,
  AGENT_BRIEFING_REPOSITORIES_MAX,
  AGENT_BRIEFING_REPOSITORY_TEXT_MAX_LENGTH,
  AGENT_BRIEFING_SECTIONS_MAX,
  AGENT_BRIEFING_SECTION_SPANS_MAX,
  AGENT_BRIEFING_SENT_BYTES_MAX,
  AGENT_BRIEFING_SEQUENCE_MAX,
  AGENT_BRIEFING_SKILLS_MAX,
  AGENT_BRIEFING_UNRESOLVED_MESSAGE_MAX_LENGTH,
  AGENT_BRIEFING_UNRESOLVED_REFERENCE_MAX_LENGTH,
  AGENT_BRIEFING_UNRESOLVED_SOURCES_MAX,
  AGENT_VISIBILITY_LABEL_MAX_LENGTH,
  AGENT_VISIBILITY_MESSAGE_MAX_LENGTH,
  AGENT_VISIBILITY_SCHEMA_VERSION,
  AGENT_VISIBILITY_SKILL_ID_MAX_LENGTH,
  AGENT_VISIBILITY_TITLE_MAX_LENGTH,
} from "./limits";
import {
  byteCountSchema,
  checkJoinKey,
  hashSchema,
  joinKeyFields,
  repositoryKeyReadSchema,
  sha256HexSchema,
  visibilityIdSchema,
  visibilityTimestampSchema,
  type Assignable,
} from "./primitives";
import {
  REPOSITORY_STATES,
  USABLE_REPOSITORY_STATES,
  isKnownSlug,
  visibilitySlugSchema,
} from "./vocabulary";

/** A part id: lower case, `[a-z0-9_.:-]`, at most 96. A repeated id gets an
 *  ordinal suffix (`ticket_comment.2`) from the builder. */
export const AGENT_BRIEFING_PART_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;

const titleSchema = z.string().max(AGENT_VISIBILITY_TITLE_MAX_LENGTH);
const labelSchema = z.string().max(AGENT_VISIBILITY_LABEL_MAX_LENGTH);
const messageSchema = z.string().max(AGENT_VISIBILITY_MESSAGE_MAX_LENGTH);
const repositoryTextSchema = z.string().max(AGENT_BRIEFING_REPOSITORY_TEXT_MAX_LENGTH);
const version = z.literal(AGENT_VISIBILITY_SCHEMA_VERSION);

/** A half-open UTF-8 byte range `[start, end)` in a section's STORED text. */
const byteRangeSchema = z
  .object({ start: byteCountSchema, end: byteCountSchema })
  .refine((range) => range.start <= range.end, {
    message: "a range ends at or after its start",
    path: ["end"],
  });
export type ByteRange = z.infer<typeof byteRangeSchema>;

/**
 * WHICH SEND THIS IS, and what everything joins on: the Block Attempt's
 * four-part identity plus the sequence of the send within it.
 *
 * `sequence` is ONE counter per Block Attempt shared by every kind, in send
 * order, starting at 1: discovery runs inside the planning attempt before its
 * first pass, so separate counters would collide on the unique key.
 * `passLabel` is what restarted this pass, in the run's words
 * (`researchPhaseIdentity`); absent means nothing was said, never "first".
 */
export const agentBriefingIdentitySchema = z.object({
  runId: visibilityIdSchema,
  nodeId: visibilityIdSchema,
  /** 1 for the first attempt at a node. */
  attempt: z.number().int().min(1),
  /** `"root"` outside any loop; never null, because it is part of a unique key. */
  activationScopeId: visibilityIdSchema,
  sequence: z.number().int().min(1).max(AGENT_BRIEFING_SEQUENCE_MAX),
  /** `discovery | agent | llm` (`AGENT_BRIEFING_KINDS`), read as a slug. */
  kind: visibilitySlugSchema,
  /** Free text rather than the block-type enum: a retired block type must
   *  still read back. */
  blockType: visibilityIdSchema,
  passLabel: titleSchema.optional(),
  /** The moment of the send, as the caller recorded it. */
  capturedAt: visibilityTimestampSchema,
});
export type AgentBriefingIdentity = z.infer<typeof agentBriefingIdentitySchema>;

/**
 * What the harness was told beside the prompt, only as far as this product
 * decides it and can therefore state it honestly.
 */
export const agentBriefingHarnessSchema = z
  .object({
    /** `claude | codex` today (`AGENT_BRIEFING_PROVIDERS`). */
    provider: visibilitySlugSchema,
    /** The model id the send passed, not the one a profile asks for. */
    model: labelSchema.min(1),
    /** Whether a structured output schema went with the prompt, and which one. */
    outputSchema: z.object({ sha256: sha256HexSchema }).nullable(),
    /** Pinned skills delivered with the send, each with its version, its
     *  artifact hash, or both; the first `AGENT_BRIEFING_SKILLS_MAX`. */
    skills: z
      .array(
        z
          .object({
            id: z.string().min(1).max(AGENT_VISIBILITY_SKILL_ID_MAX_LENGTH),
            version: z.number().int().min(0).nullable(),
            sha256: sha256HexSchema.nullable(),
          })
          .refine((skill) => skill.version !== null || skill.sha256 !== null, {
            message: "a skill names its version, its hash, or both",
          }),
      )
      .max(AGENT_BRIEFING_SKILLS_MAX),
    /** Every skill delivered, listed or not. */
    skillCount: byteCountSchema,
    /**
     * The pinned harness profile, or the fact that there was none.
     *
     * A union rather than a nullable profile beside a boolean, so "unpinned, and
     * here is the profile" cannot be written. Discovery runs on the legacy
     * unpinned path and may not claim one (checked on the index). The id is a
     * join key into the profiles: stored whole, or withheld (`idWithheld`).
     */
    profile: z.discriminatedUnion("pinned", [
      z.object({
        pinned: z.literal(true),
        ...joinKeyFields,
        version: z.number().int().min(1),
      }),
      z.object({ pinned: z.literal(false) }),
    ]),
    /** The wrapper script that launched the CLI, where every flag lives. Null for
     *  an in-process call, which has none. */
    wrapperScriptSha256: sha256HexSchema.nullable(),
    /**
     * The profile switches the compilation applied. Absent where no compilation
     * ran (discovery, `call_llm`). A profile with `includeWorkflowData` off
     * sends no runtime data, and our platform rules go with it, which is why a
     * briefing can show none.
     */
    includeWorkflowData: z.boolean().optional(),
    includeRepositoryInstructions: z.boolean().optional(),
  })
  .superRefine((harness, ctx) => {
    if (harness.skills.length > harness.skillCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "skillCount counts at least the skills listed",
        path: ["skillCount"],
      });
    }
    if (harness.profile.pinned) checkJoinKey(harness.profile, ctx, ["profile"]);
  });
export type AgentBriefingHarness = z.infer<typeof agentBriefingHarnessSchema>;

/** Where a part's text came from. `kind` is open (`AGENT_BRIEFING_ORIGIN_KINDS`
 *  lists what a renderer can label); `ref` points at the source (a comment id,
 *  a binding, a rule id); `label` is what a person calls it, often a person's
 *  name, and passes the sanitizer like every free-text field. */
export const agentBriefingOriginSchema = z.object({
  kind: visibilitySlugSchema,
  ref: labelSchema.optional(),
  label: labelSchema.optional(),
});
export type AgentBriefingOrigin = z.infer<typeof agentBriefingOriginSchema>;

export const LOSS_EXTENTS = ["none", "partial", "whole"] as const;
const lossExtentSchema = z.enum(LOSS_EXTENTS);

/**
 * One named piece of a section. The parts of a section, in order, are its
 * whole text: nothing belongs to no part and nothing to two.
 */
export const agentBriefingPartSchema = z
  .object({
    /** Unique within its section. */
    id: z.string().regex(AGENT_BRIEFING_PART_ID_PATTERN, {
      message: "a part id is lower case [a-z0-9_.:-], at most 96",
    }),
    title: titleSchema,
    origin: agentBriefingOriginSchema,
    /** UTF-8 bytes of the part as the model received it. */
    sentBytes: z.number().int().min(0).max(AGENT_BRIEFING_SENT_BYTES_MAX),
    /** Whether text of this part was removed before sending. */
    cutBeforeSend: lossExtentSchema,
    /** What removed it (`AGENT_BRIEFING_CUT_CAUSES`, read as a slug), and the
     *  part's length before, in UTF-16 code units because that is the unit the
     *  compiler and the composer cap in. Both present exactly when something
     *  was cut. */
    cutCause: visibilitySlugSchema.optional(),
    originalLengthUtf16: z.number().int().min(1).optional(),
    /** Whether our storage budget kept less of this part than was sent. */
    truncatedForStorage: lossExtentSchema,
    /** A platform rule deliberately not sent this time, and why. Such a part is
     *  zero bytes and is recorded so a person sees the rule was left out on
     *  purpose rather than lost. */
    withheld: z.object({ reason: visibilitySlugSchema, text: messageSchema }).optional(),
    /** The composer named this part and it held no text: kept, so a person sees
     *  the slot was there and empty rather than missing. */
    empty: z.literal(true).optional(),
    /** Control characters (ANSI sequences, NUL and the like) stripped from this
     *  part's stored copy. Counted rather than listed as spans. */
    controlCharactersStripped: z.number().int().min(1).optional(),
    range: byteRangeSchema,
  })
  .superRefine((part, ctx) => {
    const issue = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    const cut = part.cutBeforeSend !== "none";
    if (cut !== (part.originalLengthUtf16 !== undefined)) {
      issue("originalLengthUtf16 is present exactly when text was cut before sending", "originalLengthUtf16");
    }
    if (cut !== (part.cutCause !== undefined)) {
      issue("cutCause is present exactly when text was cut before sending", "cutCause");
    }
    if (part.cutBeforeSend === "whole" && part.sentBytes !== 0) {
      issue("a part cut whole before sending sent nothing", "sentBytes");
    }
    if (part.cutBeforeSend === "partial" && part.sentBytes === 0) {
      issue("a part cut partially before sending sent something", "sentBytes");
    }
    if (part.withheld !== undefined && (part.sentBytes !== 0 || cut || part.empty)) {
      issue("a withheld part sent nothing, was not cut and is not flagged empty", "withheld");
    }
    if (part.empty && (part.sentBytes !== 0 || cut)) {
      issue("an empty part sent nothing and was not cut", "empty");
    }
    if (part.sentBytes === 0 && part.withheld === undefined && part.cutBeforeSend !== "whole" && !part.empty) {
      issue("a part that sent nothing is withheld, cut whole, or flagged empty", "sentBytes");
    }
  });
export type AgentBriefingPart = z.infer<typeof agentBriefingPartSchema>;

/**
 * Where text was removed from the stored copy, in stored-text byte
 * coordinates. `[start, end)` covers the replacement marker. A zero-width span
 * marks text removed without one: the rest of a secret that began in the
 * previous part, whose marker sits where it began.
 */
export const agentBriefingRedactionSpanSchema = z
  .object({ start: byteCountSchema, end: byteCountSchema, kind: visibilitySlugSchema })
  .refine((span) => span.start <= span.end, {
    message: "a redaction ends at or after its start",
    path: ["end"],
  });
export type AgentBriefingRedactionSpan = z.infer<typeof agentBriefingRedactionSpanSchema>;

/** The compiler's provenance of a section, as it gave it. `id` is a join key
 *  into the prompt library (`promptId:promptName`), the catalog or the
 *  profiles: stored whole, or withheld (`idWithheld`) when longer than a page
 *  can carry or holding something the detector reports. */
const agentBriefingProvenanceSchema = z
  .object({
    kind: visibilitySlugSchema,
    ...joinKeyFields,
    version: z.number().int().nullable(),
    hash: hashSchema,
  })
  .superRefine((entry, ctx) => checkJoinKey(entry, ctx));

/**
 * A section without its parts and spans: what a section header serves.
 *
 * Sizes: `sentBytes` is what the model received; `redactedBytes` is that text
 * after redaction; `storedBytes` is what the budget kept of it. Redaction is
 * reported by the spans, so `redactedBytes > storedBytes` means one thing only:
 * the storage budget cut this section.
 */
export const agentBriefingSectionFieldsSchema = z.object({
  /** Position in the briefing, and the handle a page request names. */
  index: z.number().int().min(0).max(AGENT_BRIEFING_SECTIONS_MAX - 1),
  /** `AGENT_BRIEFING_SECTION_KINDS`, read as a slug. */
  kind: visibilitySlugSchema,
  title: titleSchema,
  /** The first `AGENT_BRIEFING_PROVENANCE_MAX` entries; `provenanceCount`
   *  counts them all. */
  provenance: z.array(agentBriefingProvenanceSchema).max(AGENT_BRIEFING_PROVENANCE_MAX),
  provenanceCount: byteCountSchema,
  sentBytes: z.number().int().min(0).max(AGENT_BRIEFING_SENT_BYTES_MAX),
  /** The digest of what the model received, so a person holding the prompt
   *  can prove it is this one even where the stored copy is cut. */
  sentSha256: sha256HexSchema,
  redactedBytes: z.number().int().min(0).max(AGENT_BRIEFING_SENT_BYTES_MAX),
  storedBytes: z.number().int().min(0).max(AGENT_BRIEFING_MAX_BUDGET_BYTES),
  /** The key of the stored text and the digest of exactly what pages return. */
  storedSha256: sha256HexSchema,
  truncatedForStorage: z.boolean(),
  /** Every redaction applied to this section, including those in text the
   *  budget then cut and those past the listing ceiling. */
  redactionCount: byteCountSchema,
  /** Every marker in the stored text is in `redactions`. False means markers
   *  past the list cannot be located, and a `[REDACTED]` there may be ours or
   *  a person's. */
  redactionListComplete: z.boolean(),
});

/** The size rules every section and section header satisfies. */
export function checkSectionSizes(
  section: {
    redactedBytes: number;
    storedBytes: number;
    truncatedForStorage: boolean;
    provenance: readonly unknown[];
    provenanceCount: number;
  },
  ctx: z.RefinementCtx,
): void {
  if (section.provenance.length > section.provenanceCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provenanceCount counts at least the entries listed",
      path: ["provenanceCount"],
    });
  }
  if (section.storedBytes > section.redactedBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a section stores at most what it had after redaction",
      path: ["storedBytes"],
    });
  }
  if (section.truncatedForStorage !== section.redactedBytes > section.storedBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "truncatedForStorage is true exactly when storage kept less than redaction left",
      path: ["truncatedForStorage"],
    });
  }
}

/**
 * One section of the prompt: its identity, its sizes and hashes, its spans and
 * its parts. Never its text, which is stored once under `storedSha256` and read
 * a page at a time.
 */
export const agentBriefingSectionSchema = agentBriefingSectionFieldsSchema
  .extend({
    /** The spans inside the stored text, the first
     *  `AGENT_BRIEFING_SECTION_SPANS_MAX` of them at most (fewer when the index
     *  bound took some); `redactionListComplete` says whether that is all. */
    redactions: z.array(agentBriefingRedactionSpanSchema).max(AGENT_BRIEFING_SECTION_SPANS_MAX),
    parts: z.array(agentBriefingPartSchema).max(AGENT_BRIEFING_PARTS_PER_SECTION_MAX),
  })
  .superRefine((section, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    checkSectionSizes(section, ctx);
    if (section.redactions.length > section.redactionCount) {
      issue("redactionCount counts at least the spans listed", ["redactionCount"]);
    }
    if (!section.redactionListComplete && section.redactions.length >= section.redactionCount) {
      issue("a span list that is not complete leaves redactions out", ["redactionListComplete"]);
    }
    let previousEnd = 0;
    section.redactions.forEach((span, position) => {
      if (span.start < previousEnd || span.end > section.storedBytes) {
        issue("redactions are ordered, apart and inside the stored text", ["redactions", position]);
      }
      previousEnd = span.end;
    });
    // The parts follow each other from byte 0 and cover the stored text.
    let cursor = 0;
    const ids = new Set<string>();
    section.parts.forEach((part, position) => {
      if (part.range.start !== cursor || part.range.end > section.storedBytes) {
        issue("parts follow each other from byte 0 inside the stored text", ["parts", position, "range"]);
      }
      if (ids.has(part.id)) issue(`part id "${part.id}" is repeated`, ["parts", position, "id"]);
      ids.add(part.id);
      cursor = part.range.end;
    });
    if (cursor !== section.storedBytes) {
      issue("the parts cover the stored text", ["parts"]);
    }
  });
export type AgentBriefingSection = z.infer<typeof agentBriefingSectionSchema>;

/** A person or a run, as the record wrote it; open so a new actor kind reads. */
const workScopeActorViewSchema = z.object({
  kind: visibilitySlugSchema,
  actorId: z.string().optional(),
  actorLabel: z.string().optional(),
  runId: z.string().optional(),
  definitionId: z.number().int().optional(),
  definitionVersion: z.number().int().optional(),
  model: z.string().optional(),
});

/**
 * The Work Scope entry a repository had at the moment of the send.
 *
 * The same fields as `workScopeEntrySchema` in `@shared/contracts`, read with
 * open slugs and bounded strings: that schema is the WRITE contract and is
 * closed, so embedding it would make the first new origin, or the first key on
 * a provider this build does not know, unreadable here.
 */
export const agentBriefingWorkScopeEntrySchema = z.object({
  repositoryKey: repositoryKeyReadSchema,
  state: visibilitySlugSchema,
  unavailableReason: visibilitySlugSchema.optional(),
  origin: visibilitySlugSchema,
  rationale: messageSchema,
  decidedBy: workScopeActorViewSchema,
  decidedAt: visibilityTimestampSchema,
});
export type AgentBriefingWorkScopeEntry = z.infer<typeof agentBriefingWorkScopeEntrySchema>;
// The write contract must stay readable through the view above: a field added
// to the contract's entry or actor that this view cannot hold fails typecheck.
// oxlint-disable-next-line no-unused-vars -- a compile-time check, not a type anything uses
type WorkScopeEntryReadsAsView = Assignable<WorkScopeEntry, AgentBriefingWorkScopeEntry> &
  Assignable<WorkScopeActor, z.infer<typeof workScopeActorViewSchema>>;

/** The rules a repository of a context satisfies, on write and on read. */
export function checkRepository(
  repository: {
    state: string;
    reason?: string | undefined;
    inclusion: { cause: string; via?: unknown };
    description: { source: string; text: string };
  },
  ctx: z.RefinementCtx,
): void {
  const unusable =
    isKnownSlug(REPOSITORY_STATES, repository.state) &&
    !isKnownSlug(USABLE_REPOSITORY_STATES, repository.state);
  if (unusable && !repository.reason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `state "${repository.state}" says why the repository may not be used`,
      path: ["reason"],
    });
  }
  if (repository.inclusion.cause === "related" && repository.inclusion.via === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a related repository names the repository and relationship it came through",
      path: ["inclusion", "via"],
    });
  }
  if (repository.description.source === "none" && repository.description.text !== "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a description with no source has no text",
      path: ["description", "text"],
    });
  }
}

/**
 * A repository as this send described it to the model, in map order.
 */
export const agentBriefingRepositorySchema = z
  .object({
    key: repositoryKeyReadSchema,
    /** The description the agent read and whose words they were:
     *  `REPOSITORY_DESCRIPTION_SOURCES`. `none` has empty text. */
    description: z.object({ source: visibilitySlugSchema, text: repositoryTextSchema }),
    /** The catalog rules the send rendered, null where it rendered none. */
    rules: repositoryTextSchema.nullable(),
    /** Relationships the send showed, pointing at repository keys: the first
     *  `AGENT_BRIEFING_RELATIONSHIPS_MAX`; `relationshipCount` counts them all. */
    relationships: z
      .array(
        z.object({
          kind: visibilitySlugSchema,
          target: repositoryKeyReadSchema,
          /**
           * Which side of the relationship this repository is on:
           * `outgoing` where it recorded the relationship, `incoming` where
           * the other end did.
           *
           * NOT DECORATION. The catalog stores one edge and two sentences for
           * it, and reading an incoming edge forwards says the opposite of
           * what the operator recorded: "the API holds tests for the e2e
           * suite" where the e2e suite holds tests for the API. A page that
           * renders the pair without it tells a person the reverse of what
           * their agent was told. Optional because a send whose run predates
           * the repository map recorded no direction, and absent means
           * exactly that: unknown, not `outgoing`.
           */
          direction: visibilitySlugSchema.optional(),
          note: labelSchema.optional(),
        }),
      )
      .max(AGENT_BRIEFING_RELATIONSHIPS_MAX),
    relationshipCount: byteCountSchema,
    /** `REPOSITORY_STATES`; every known state outside `USABLE_REPOSITORY_STATES`
     *  carries its reason. */
    state: visibilitySlugSchema,
    reason: messageSchema.optional(),
    /** Why the repository is in the context (`REPOSITORY_INCLUSION_CAUSES`);
     *  `related` names the repository and relationship it came through. */
    inclusion: z.object({
      cause: visibilitySlugSchema,
      via: z.object({ key: repositoryKeyReadSchema, relationship: visibilitySlugSchema }).optional(),
    }),
    /** `full` or `line` (`REPOSITORY_RENDERINGS`). */
    rendering: visibilitySlugSchema,
    workScopeEntry: agentBriefingWorkScopeEntrySchema.nullable(),
  })
  .superRefine((repository, ctx) => {
    checkRepository(repository, ctx);
    if (repository.relationships.length > repository.relationshipCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relationshipCount counts at least the relationships listed",
        path: ["relationshipCount"],
      });
    }
  });
export type AgentBriefingRepository = z.infer<typeof agentBriefingRepositorySchema>;

/**
 * THE REPOSITORY CONTEXT DOCUMENT: the repositories one send described, stored
 * as JSON text beside the section texts, under the sha256 of that text.
 *
 * Stored once per distinct content, so the six planning passes of one attempt,
 * which see the same map, store it once. Its repositories are served as a
 * list of their own. It lists the first `AGENT_BRIEFING_REPOSITORIES_MAX`
 * repositories and left-out keys; the reference in the index counts them all.
 */
export const agentBriefingRepositoryContextSchema = z.object({
  schemaVersion: version,
  repositories: z.array(agentBriefingRepositorySchema).max(AGENT_BRIEFING_REPOSITORIES_MAX),
  /** Catalog repositories the map summarized as a count ("and 40 more, ask by
   *  name") instead of listing. */
  unlistedCount: byteCountSchema,
  /** The record as the send saw it; null for a subject that keeps no record. */
  workScope: z
    .object({
      version: z.number().int().min(0),
      /** Repositories a person's answer left out. */
      leftOutKeys: z.array(repositoryKeyReadSchema).max(AGENT_BRIEFING_REPOSITORIES_MAX),
    })
    .nullable(),
});
export type AgentBriefingRepositoryContext = z.infer<typeof agentBriefingRepositoryContextSchema>;

/** Where in the briefing the map text itself sits, so a page can link the
 *  structured entry to the exact line the agent read. */
const partPointerSchema = z.object({
  sectionIndex: z.number().int().min(0),
  partId: z.string().regex(AGENT_BRIEFING_PART_ID_PATTERN),
});

/** What the index says about the repository context document: where it is
 *  stored and what it holds, so a header renders before the document is read. */
export const agentBriefingRepositoryContextRefSchema = z.object({
  sha256: sha256HexSchema,
  bytes: z.number().int().min(0).max(AGENT_BRIEFING_CONTEXT_MAX_BYTES),
  repositoryCount: byteCountSchema,
  unlistedCount: byteCountSchema,
  /** The record's version, or null for a subject that keeps no record. */
  workScopeVersion: z.number().int().min(0).nullable(),
  leftOutCount: byteCountSchema,
  /** Redactions in the document's descriptions, rules and reasons. */
  redactionCount: byteCountSchema,
  renderedAt: partPointerSchema.optional(),
});
export type AgentBriefingRepositoryContextRef = z.infer<typeof agentBriefingRepositoryContextRefSchema>;

export const agentBriefingUnresolvedSourceSchema = z.object({
  kind: visibilitySlugSchema,
  reference: z.string().max(AGENT_BRIEFING_UNRESOLVED_REFERENCE_MAX_LENGTH),
  message: z.string().max(AGENT_BRIEFING_UNRESOLVED_MESSAGE_MAX_LENGTH),
});
export type AgentBriefingUnresolvedSource = z.infer<typeof agentBriefingUnresolvedSourceSchema>;

export const agentBriefingTotalsSchema = z.object({
  sections: byteCountSchema,
  sentBytes: byteCountSchema,
  storedBytes: byteCountSchema,
  redactions: byteCountSchema,
  truncatedSections: byteCountSchema,
});

/**
 * THE BRIEFING INDEX: everything about one send except the text of its
 * sections and its repository context, which live in a map from sha256 to
 * text beside it. Bounded by `AGENT_BRIEFING_INDEX_MAX_BYTES` when built.
 */
export const agentBriefingIndexSchema = z
  .object({
    schemaVersion: version,
    identity: agentBriefingIdentitySchema,
    harness: agentBriefingHarnessSchema,
    /** The budget the stored texts were cut to, so "truncated" says against what. */
    budgetBytes: z.number().int().min(0).max(AGENT_BRIEFING_MAX_BUDGET_BYTES),
    sections: z.array(agentBriefingSectionSchema).max(AGENT_BRIEFING_SECTIONS_MAX),
    /** Null when the send rendered no repository context (an in-process call). */
    repositoryContext: agentBriefingRepositoryContextRefSchema.nullable(),
    /** Sources the compiler could not resolve, which is why an expected
     *  AGENTS.md or profile may be missing from the sections; the first
     *  `AGENT_BRIEFING_UNRESOLVED_SOURCES_MAX`. */
    unresolvedSources: z
      .array(agentBriefingUnresolvedSourceSchema)
      .max(AGENT_BRIEFING_UNRESOLVED_SOURCES_MAX),
    unresolvedSourceCount: byteCountSchema,
    /** Redactions in the index's own free text (titles, labels, withheld
     *  rules, the pass label, the model id), which have no spans because they
     *  are not section text. */
    metadataRedactions: byteCountSchema,
    /** Sums over the sections, for a header that renders before the list. */
    totals: agentBriefingTotalsSchema,
  })
  .superRefine((index, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    index.sections.forEach((section, position) => {
      if (section.index !== position) {
        issue("section indexes are their positions, from 0", ["sections", position, "index"]);
      }
    });
    const sum = (pick: (section: AgentBriefingSection) => number) =>
      index.sections.reduce((total, section) => total + pick(section), 0);
    const expected = {
      sections: index.sections.length,
      sentBytes: sum((section) => section.sentBytes),
      storedBytes: sum((section) => section.storedBytes),
      redactions: sum((section) => section.redactionCount),
      truncatedSections: index.sections.filter((section) => section.truncatedForStorage).length,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (index.totals[field as keyof typeof expected] !== value) {
        issue(`totals.${field} is the sum over the sections`, ["totals", field]);
      }
    }
    if (index.unresolvedSources.length > index.unresolvedSourceCount) {
      issue("unresolvedSourceCount counts at least the sources listed", ["unresolvedSourceCount"]);
    }
    if (index.identity.kind === "discovery" && index.harness.profile.pinned) {
      issue("discovery runs on the unpinned harness path and cannot claim a profile", [
        "harness",
        "profile",
      ]);
    }
    const pointer = index.repositoryContext?.renderedAt;
    if (
      pointer &&
      !index.sections[pointer.sectionIndex]?.parts.some((part) => part.id === pointer.partId)
    ) {
      issue("renderedAt names a part of this briefing", ["repositoryContext", "renderedAt"]);
    }
  });
export type AgentBriefingIndex = z.infer<typeof agentBriefingIndexSchema>;
