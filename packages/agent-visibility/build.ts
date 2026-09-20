/**
 * Building the stored record of one send.
 *
 * The worker's capture adapter maps what it sent (a compilation, the discovery
 * prompt, a `call_llm` prompt) to `AgentBriefingBuildInput`; this package never
 * sees the compiler, so neither package knows the other. The sanitizer and the
 * storage budget come in as dependencies: the sanitizer reads configured
 * secrets from the environment, which a pure package may not.
 *
 * Refuses broken structure (parts that do not tile their section, a key that is
 * not a key); never refuses long free text, which it shortens and says so. A
 * refusal becomes "not recorded" about a prompt that was sent, so it is kept
 * for what no reader could trust.
 *
 * Deterministic: every id and time comes from the input, nothing reads a clock
 * or randomness, and the same input yields byte-identical output.
 */
import { z } from "zod";
import { repositoryKeySchema, type WorkScopeActor, type WorkScopeEntry } from "@shared/contracts";
import {
  agentBriefingIndexSchema,
  agentBriefingRepositoryContextSchema,
  checkRepository,
  type AgentBriefingIndex,
  type AgentBriefingPart,
  type AgentBriefingRepository,
  type AgentBriefingRepositoryContext,
  type AgentBriefingRepositoryContextRef,
  type AgentBriefingSection,
} from "./briefing-schema";
import {
  AGENT_BRIEFING_CONTEXT_MAX_BYTES,
  AGENT_BRIEFING_DEFAULT_BUDGET_BYTES,
  AGENT_BRIEFING_INDEX_MAX_BYTES,
  AGENT_BRIEFING_MAX_BUDGET_BYTES,
  AGENT_BRIEFING_PARTS_PER_SECTION_MAX,
  AGENT_BRIEFING_PROVENANCE_MAX,
  AGENT_BRIEFING_RELATIONSHIPS_MAX,
  AGENT_BRIEFING_REPOSITORIES_MAX,
  AGENT_BRIEFING_REPOSITORY_TEXT_MAX_LENGTH,
  AGENT_BRIEFING_SECTIONS_MAX,
  AGENT_BRIEFING_SECTION_SPANS_MAX,
  AGENT_BRIEFING_SEQUENCE_MAX,
  AGENT_BRIEFING_SKILLS_MAX,
  AGENT_BRIEFING_UNRESOLVED_MESSAGE_MAX_LENGTH,
  AGENT_BRIEFING_UNRESOLVED_REFERENCE_MAX_LENGTH,
  AGENT_BRIEFING_UNRESOLVED_SOURCES_MAX,
  AGENT_VISIBILITY_ID_MAX_LENGTH,
  AGENT_VISIBILITY_JOIN_KEY_MAX_BYTES,
  AGENT_VISIBILITY_LABEL_MAX_LENGTH,
  AGENT_VISIBILITY_MESSAGE_MAX_LENGTH,
  AGENT_VISIBILITY_SCHEMA_VERSION,
  AGENT_VISIBILITY_SKILL_ID_MAX_LENGTH,
  AGENT_VISIBILITY_TITLE_MAX_LENGTH,
} from "./limits";
import {
  hashSchema,
  joinKeyBytes,
  sha256HexSchema,
  visibilityIdSchema,
  visibilityTimestampSchema,
  type Assignable,
} from "./primitives";
import { describeIssues } from "./read";
import {
  AgentVisibilityInputError,
  clampSanitized,
  redactSection,
  sanitizeText,
  type AppliedSpan,
  type SanitizedText,
  type VisibilitySanitizer,
} from "./redact";
import {
  jsonBytes,
  sha256Hex,
  splitsSurrogatePair,
  utf16IndexAtByte,
  utf16IndexWithinBytes,
  utf8Length,
  wellFormed,
} from "./text";
import {
  AGENT_BRIEFING_KINDS,
  PROVENANCE_SECTION_KINDS,
  RUN_DATA_SECTION_KINDS,
  isKnownSlug,
  visibilitySlugSchema,
} from "./vocabulary";

/** Leaves room for the ordinal suffix a repeated id gets. */
const PART_ID_INPUT_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,87}$/;

/** The shortest a free-text field is cut to when a record would not otherwise
 *  fit its bound. */
const FREE_TEXT_FLOOR = 16;

const partInputSchema = z
  .object({
    id: z.string().regex(PART_ID_INPUT_PATTERN, {
      message: "a part id is lower case [a-z0-9_.:-], at most 88",
    }),
    title: z.string(),
    origin: z
      .object({ kind: visibilitySlugSchema, ref: z.string().optional(), label: z.string().optional() })
      .strict(),
    /** The part's text exactly as sent. May be empty: the part is then kept
     *  and flagged `empty`. */
    content: z.string(),
    /** Present when text of this part was removed before sending: why
     *  (`AGENT_BRIEFING_CUT_CAUSES`), and its length before, in the UTF-16
     *  units the compiler and the composer count. */
    cut: z
      .object({ originalLengthUtf16: z.number().int().min(1), cause: visibilitySlugSchema })
      .strict()
      .optional(),
    /** A platform rule deliberately not sent: `content` is empty. */
    withheld: z.object({ reason: visibilitySlugSchema, text: z.string() }).strict().optional(),
  })
  .strict();

const sectionInputSchema = z
  .object({
    kind: visibilitySlugSchema,
    title: z.string(),
    /** As the compiler gave it, however many and however long: the first
     *  `AGENT_BRIEFING_PROVENANCE_MAX` are listed and all are counted, and an
     *  id is stored whole or withheld, never cut or redacted. */
    provenance: z
      .array(
        z
          .object({
            kind: visibilitySlugSchema,
            id: z.string(),
            version: z.number().int().nullable(),
            hash: hashSchema,
          })
          .strict(),
      )
      .optional(),
    /** The exact text between the section's sentinels as sent. */
    text: z.string(),
    /** Omitted: one part named after the section kind covers the whole text. */
    parts: z.array(partInputSchema).max(AGENT_BRIEFING_PARTS_PER_SECTION_MAX).optional(),
  })
  .strict();

const workScopeEntryInputSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    state: visibilitySlugSchema,
    unavailableReason: visibilitySlugSchema.optional(),
    origin: visibilitySlugSchema,
    rationale: z.string(),
    decidedBy: z
      .object({
        kind: visibilitySlugSchema,
        actorId: z.string().max(AGENT_VISIBILITY_ID_MAX_LENGTH).optional(),
        actorLabel: z.string().optional(),
        runId: z.string().max(AGENT_VISIBILITY_ID_MAX_LENGTH).optional(),
        definitionId: z.number().int().optional(),
        definitionVersion: z.number().int().optional(),
        model: z.string().optional(),
      })
      .strict(),
    decidedAt: visibilityTimestampSchema,
  })
  .strict();
// The adapter passes the record's entries as they are.
// oxlint-disable-next-line no-unused-vars -- a compile-time check, not a type anything uses
type WorkScopeEntryPassable = Assignable<WorkScopeEntry, z.input<typeof workScopeEntryInputSchema>> &
  Assignable<WorkScopeActor, z.input<typeof workScopeEntryInputSchema>["decidedBy"]>;

const repositoryInputSchema = z
  .object({
    key: repositoryKeySchema,
    description: z.object({ source: visibilitySlugSchema, text: z.string() }).strict(),
    rules: z.string().nullable(),
    relationships: z
      .array(
        z
          .object({
            kind: visibilitySlugSchema,
            target: repositoryKeySchema,
            /** Which side of the edge this repository is on; see
             *  `agentBriefingRepositorySchema`. The shape is STRICT, so an
             *  adapter handing over a field the schema does not know refuses
             *  the whole send and stores a marker instead, silently. */
            direction: visibilitySlugSchema.optional(),
            note: z.string().optional(),
          })
          .strict(),
      ),
    state: visibilitySlugSchema,
    reason: z.string().optional(),
    inclusion: z
      .object({
        cause: visibilitySlugSchema,
        via: z.object({ key: repositoryKeySchema, relationship: visibilitySlugSchema }).strict().optional(),
      })
      .strict(),
    rendering: visibilitySlugSchema,
    workScopeEntry: workScopeEntryInputSchema.nullable(),
  })
  .strict()
  .superRefine(checkRepository);

const repositoryContextInputSchema = z
  .object({
    repositories: z.array(repositoryInputSchema),
    unlistedCount: z.number().int().min(0),
    workScope: z
      .object({
        version: z.number().int().min(0),
        leftOutKeys: z.array(repositoryKeySchema),
      })
      .strict()
      .nullable(),
    /** The part of this briefing the map text was rendered in. */
    renderedAt: z.object({ sectionIndex: z.number().int().min(0), partId: z.string() }).strict().optional(),
  })
  .strict();

const buildInputSchema = z
  .object({
    identity: z
      .object({
        runId: visibilityIdSchema,
        nodeId: visibilityIdSchema,
        attempt: z.number().int().min(1),
        activationScopeId: visibilityIdSchema,
        sequence: z.number().int().min(1).max(AGENT_BRIEFING_SEQUENCE_MAX),
        kind: z.enum(AGENT_BRIEFING_KINDS),
        blockType: visibilityIdSchema,
        passLabel: z.string().optional(),
        capturedAt: visibilityTimestampSchema,
      })
      .strict(),
    harness: z
      .object({
        provider: visibilitySlugSchema,
        model: z.string().min(1),
        /** The output schema text as sent, or null when none went. */
        outputSchema: z.string().nullable().optional(),
        skills: z
          .array(
            z
              .object({
                id: z.string().min(1),
                version: z.number().int().min(0).optional(),
                sha256: sha256HexSchema.optional(),
              })
              .strict()
              .refine((skill) => skill.version !== undefined || skill.sha256 !== undefined, {
                message: "a skill names its version, its hash, or both",
              }),
          )
          .optional(),
        /** The pinned harness profile, or null for an unpinned send. Its id is
         *  a join key: stored whole, or withheld, never cut or redacted. */
        profile: z
          .object({ id: z.string().min(1), version: z.number().int().min(1) })
          .strict()
          .nullable()
          .optional(),
        /** The wrapper script text, or null for an in-process call. */
        wrapperScript: z.string().nullable().optional(),
        /** The profile switches the compilation applied; omitted where none ran. */
        includeWorkflowData: z.boolean().optional(),
        includeRepositoryInstructions: z.boolean().optional(),
      })
      .strict(),
    sections: z.array(sectionInputSchema).max(AGENT_BRIEFING_SECTIONS_MAX),
    repositoryContext: repositoryContextInputSchema.nullable().optional(),
    unresolvedSources: z
      .array(z.object({ kind: visibilitySlugSchema, reference: z.string(), message: z.string() }).strict())
      .optional(),
  })
  .strict();

/** What the capture adapter passes for one send. */
export type AgentBriefingBuildInput = z.input<typeof buildInputSchema>;
type ParsedSection = z.output<typeof sectionInputSchema>;
type ParsedPart = z.output<typeof partInputSchema>;
type ParsedContext = z.output<typeof repositoryContextInputSchema>;

export interface AgentBriefingBuildDependencies {
  sanitize: VisibilitySanitizer;
  /** UTF-8 bytes of section text one briefing may store; default 512 KB. */
  budgetBytes?: number;
}

/**
 * The index plus each stored text once, keyed by the sha256 of what is stored:
 * the section texts in the order the sections first use them, then the
 * repository context document.
 */
export interface AgentBriefingBuild {
  index: AgentBriefingIndex;
  texts: { sha256: string; text: string }[];
}

type Sanitize = (value: string, where: string) => SanitizedText;

interface PreparedPart {
  input: ParsedPart;
  id: string;
  title: SanitizedText;
  ref?: SanitizedText;
  label?: SanitizedText;
  withheld?: SanitizedText;
  sentBytes: number;
  controlCharactersStripped: number;
  /** Byte range in the redacted section text. */
  start: number;
  end: number;
}

interface PreparedSection {
  input: ParsedSection;
  index: number;
  title: SanitizedText;
  sent: string;
  sentBytes: number;
  redacted: string;
  redactedBytes: number;
  /** In redacted-section coordinates, control characters excluded. */
  spans: AppliedSpan[];
  parts: PreparedPart[];
}

/** A section with everything decided but its free text and how many spans it
 *  lists, which the index bound may still reduce. */
interface StoredSection {
  prepared: PreparedSection;
  fields: Omit<AgentBriefingSection, "title" | "parts" | "redactions" | "redactionListComplete">;
  /** Every span inside the stored text. */
  storedSpans: AgentBriefingSection["redactions"];
  parts: (Omit<AgentBriefingPart, "title" | "origin" | "withheld"> & { prepared: PreparedPart })[];
}

/**
 * The order in which the storage budget gives way: sections whose provenance
 * identifies their source first, run data last, everything else between.
 */
function storageTier(kind: string): number {
  if (isKnownSlug(PROVENANCE_SECTION_KINDS, kind)) return 0;
  if (isKnownSlug(RUN_DATA_SECTION_KINDS, kind)) return 2;
  return 1;
}

export async function buildAgentBriefing(
  input: AgentBriefingBuildInput,
  dependencies: AgentBriefingBuildDependencies,
): Promise<AgentBriefingBuild> {
  const parsed = buildInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentVisibilityInputError(
      `The briefing input is malformed: ${describeIssues(parsed.error.issues)}`,
    );
  }
  const value = parsed.data;
  const budget = dependencies.budgetBytes ?? AGENT_BRIEFING_DEFAULT_BUDGET_BYTES;
  if (!Number.isInteger(budget) || budget < 0 || budget > AGENT_BRIEFING_MAX_BUDGET_BYTES) {
    throw new AgentVisibilityInputError(
      `The storage budget must be a whole number of bytes from 0 to ${AGENT_BRIEFING_MAX_BUDGET_BYTES}, got ${budget}.`,
    );
  }
  if (value.identity.kind === "discovery" && value.harness.profile) {
    throw new AgentVisibilityInputError(
      "A discovery send runs on the unpinned harness path and cannot claim a harness profile.",
    );
  }
  const sanitize = dependencies.sanitize;
  const indexCounter = { redactions: 0 };
  const field: Sanitize = (text, where) => sanitizeText(text, sanitize, where, indexCounter);

  const prepared = value.sections.map((section, index) => prepareSection(section, index, sanitize, field));
  const allowed = allocateStorage(
    prepared.map((section) => ({ bytes: section.redactedBytes, tier: storageTier(section.input.kind) })),
    budget,
  );
  const texts = new Map<string, string>();
  const stored: StoredSection[] = [];
  for (const section of prepared) {
    const result = await storeSection(section, allowed[section.index]!, field);
    if (!texts.has(result.section.fields.storedSha256)) texts.set(result.section.fields.storedSha256, result.text);
    stored.push(result.section);
  }

  let repositoryContext: AgentBriefingRepositoryContextRef | null = null;
  if (value.repositoryContext) {
    const context = value.repositoryContext;
    const pointer = context.renderedAt;
    if (pointer && !prepared[pointer.sectionIndex]?.parts.some((part) => part.id === pointer.partId)) {
      throw new AgentVisibilityInputError(
        `The repository context says the map was rendered in part "${pointer.partId}" of section ${pointer.sectionIndex}, and this briefing has no such part.`,
      );
    }
    const document = await buildContextDocument(context, sanitize);
    if (!texts.has(document.sha256)) texts.set(document.sha256, document.text);
    repositoryContext = {
      sha256: document.sha256,
      bytes: document.bytes,
      repositoryCount: context.repositories.length,
      unlistedCount: context.unlistedCount,
      workScopeVersion: context.workScope?.version ?? null,
      leftOutCount: context.workScope?.leftOutKeys.length ?? 0,
      redactionCount: document.redactions,
      ...(pointer ? { renderedAt: { sectionIndex: pointer.sectionIndex, partId: pointer.partId } } : {}),
    };
  }

  const harness = value.harness;
  const identity: AgentBriefingIndex["identity"] = {
    runId: value.identity.runId,
    nodeId: value.identity.nodeId,
    attempt: value.identity.attempt,
    activationScopeId: value.identity.activationScopeId,
    sequence: value.identity.sequence,
    kind: value.identity.kind,
    blockType: value.identity.blockType,
    ...(value.identity.passLabel === undefined
      ? {}
      : {
          passLabel: clampSanitized(field(value.identity.passLabel, "the pass label"), AGENT_VISIBILITY_TITLE_MAX_LENGTH),
        }),
    capturedAt: value.identity.capturedAt,
  };
  const skills = harness.skills ?? [];
  const harnessRecord: AgentBriefingIndex["harness"] = {
    provider: harness.provider,
    model: clampSanitized(field(harness.model, "the model id"), AGENT_VISIBILITY_LABEL_MAX_LENGTH),
    outputSchema:
      harness.outputSchema === undefined || harness.outputSchema === null
        ? null
        : { sha256: await sha256Hex(wellFormed(harness.outputSchema)) },
    skills: skills.slice(0, AGENT_BRIEFING_SKILLS_MAX).map((skill) => ({
      id: clampSanitized(field(skill.id, "a skill id"), AGENT_VISIBILITY_SKILL_ID_MAX_LENGTH),
      version: skill.version ?? null,
      sha256: skill.sha256 ?? null,
    })),
    skillCount: skills.length,
    profile: harness.profile
      ? {
          pinned: true as const,
          ...(await storeJoinKey(harness.profile.id, field, "the harness profile id")),
          version: harness.profile.version,
        }
      : { pinned: false as const },
    wrapperScriptSha256:
      harness.wrapperScript === undefined || harness.wrapperScript === null
        ? null
        : await sha256Hex(wellFormed(harness.wrapperScript)),
    ...(harness.includeWorkflowData === undefined ? {} : { includeWorkflowData: harness.includeWorkflowData }),
    ...(harness.includeRepositoryInstructions === undefined
      ? {}
      : { includeRepositoryInstructions: harness.includeRepositoryInstructions }),
  };
  const unresolved = value.unresolvedSources ?? [];
  const unresolvedSources = unresolved.slice(0, AGENT_BRIEFING_UNRESOLVED_SOURCES_MAX).map((source) => ({
    kind: source.kind,
    reference: clampSanitized(field(source.reference, "an unresolved source"), AGENT_BRIEFING_UNRESOLVED_REFERENCE_MAX_LENGTH),
    message: clampSanitized(field(source.message, "an unresolved source"), AGENT_BRIEFING_UNRESOLVED_MESSAGE_MAX_LENGTH),
  }));
  const sum = (pick: (section: StoredSection["fields"]) => number) =>
    stored.reduce((total, section) => total + pick(section.fields), 0);
  const totals = {
    sections: stored.length,
    sentBytes: sum((section) => section.sentBytes),
    storedBytes: sum((section) => section.storedBytes),
    redactions: sum((section) => section.redactionCount),
    truncatedSections: stored.filter((section) => section.fields.truncatedForStorage).length,
  };

  // Every free-text field has passed the sanitizer by now, so the count is
  // whole. Section and part text fields and span lists are the only parts of
  // the index that grow with the briefing, so they alone give way to its bound.
  const assemble = (textCap: number, spanCap: number): AgentBriefingIndex => ({
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
    identity,
    harness: harnessRecord,
    budgetBytes: budget,
    sections: stored.map((section) => renderSection(section, textCap, spanCap)),
    repositoryContext,
    unresolvedSources,
    unresolvedSourceCount: unresolved.length,
    metadataRedactions: indexCounter.redactions,
    totals,
  });
  const index = fitIndex(
    assemble,
    () =>
      `The briefing index does not fit in ${AGENT_BRIEFING_INDEX_MAX_BYTES} bytes even with every section and part title, origin and withheld rule shortened to ${FREE_TEXT_FLOOR} characters and no redaction span listed: ${stored.length} sections and ${stored.reduce((total, section) => total + section.parts.length, 0)} parts are more than a briefing can record.`,
  );

  const check = agentBriefingIndexSchema.safeParse(index);
  if (!check.success) {
    // Input was validated above, so this is a defect here, not in the caller.
    throw new Error(
      `The built briefing does not satisfy its own schema: ${describeIssues(check.error.issues)}`,
    );
  }
  return {
    index,
    texts: [...texts].map(([sha256, text]) => ({ sha256, text })),
  };
}

/** The largest `n` from `low` to `high` for which `fits(n)` holds, given that
 *  `fits(low)` does and that a smaller `n` never makes a record larger. */
function largestFitting(low: number, high: number, fits: (n: number) => boolean): number {
  let best = low;
  let from = low + 1;
  let to = high;
  while (from <= to) {
    const middle = Math.floor((from + to) / 2);
    if (fits(middle)) {
      best = middle;
      from = middle + 1;
    } else to = middle - 1;
  }
  return best;
}

/**
 * `build(cap)` at the largest free-text cap whose JSON fits `maxBytes`: whole
 * when everything fits, else every growable field shortened to one common
 * length, never below `FREE_TEXT_FLOOR`. Refuses what does not fit even then,
 * rather than storing a record over its bound.
 */
function fitToBound<T>(build: (cap: number) => T, largestField: number, maxBytes: number, refusal: () => string): T {
  const fits = (value: T) => jsonBytes(value) <= maxBytes;
  const whole = build(Number.POSITIVE_INFINITY);
  if (fits(whole)) return whole;
  if (!fits(build(FREE_TEXT_FLOOR))) throw new AgentVisibilityInputError(refusal());
  return build(largestFitting(FREE_TEXT_FLOOR, largestField, (cap) => fits(build(cap))));
}

/**
 * The index at the largest caps that fit `AGENT_BRIEFING_INDEX_MAX_BYTES`.
 * Free text gives way first, because a shortened title still says how long it
 * was; then span lists, each marked incomplete where it lost spans. Refused
 * only when even titles at the floor and no spans do not fit.
 */
function fitIndex(assemble: (textCap: number, spanCap: number) => AgentBriefingIndex, refusal: () => string): AgentBriefingIndex {
  const fits = (index: AgentBriefingIndex) => jsonBytes(index) <= AGENT_BRIEFING_INDEX_MAX_BYTES;
  const whole = assemble(Number.POSITIVE_INFINITY, AGENT_BRIEFING_SECTION_SPANS_MAX);
  if (fits(whole)) return whole;
  if (fits(assemble(FREE_TEXT_FLOOR, AGENT_BRIEFING_SECTION_SPANS_MAX))) {
    const cap = largestFitting(FREE_TEXT_FLOOR, AGENT_VISIBILITY_MESSAGE_MAX_LENGTH, (textCap) =>
      fits(assemble(textCap, AGENT_BRIEFING_SECTION_SPANS_MAX)),
    );
    return assemble(cap, AGENT_BRIEFING_SECTION_SPANS_MAX);
  }
  if (!fits(assemble(FREE_TEXT_FLOOR, 0))) throw new AgentVisibilityInputError(refusal());
  const spanCap = largestFitting(0, AGENT_BRIEFING_SECTION_SPANS_MAX, (spans) => fits(assemble(FREE_TEXT_FLOOR, spans)));
  return assemble(FREE_TEXT_FLOOR, spanCap);
}

/**
 * A join key as stored: whole, or withheld as its length and sha256. The
 * detector runs over it like any stored text, but a key cannot be redacted
 * (a key with a marker in it joins to nothing), so a key it reports anything
 * in is withheld whole: a secret typed into a prompt name is never stored,
 * and nothing MCP would rewrite is. A key longer than a page can carry is
 * withheld too. Never cut, never refused.
 */
async function storeJoinKey(
  key: string,
  field: Sanitize,
  where: string,
): Promise<{ id: string } | { id: null; idWithheld: { reason: string; lengthUtf16: number; sha256: string } }> {
  const whole = wellFormed(key);
  const reason =
    field(whole, where).text !== whole
      ? "redacted"
      : joinKeyBytes(whole) > AGENT_VISIBILITY_JOIN_KEY_MAX_BYTES
        ? "too_long"
        : null;
  if (reason === null) return { id: whole };
  return { id: null, idWithheld: { reason, lengthUtf16: whole.length, sha256: await sha256Hex(whole) } };
}

/** One provenance entry as stored, its id through `storeJoinKey`. */
async function storeProvenance(
  entry: NonNullable<ParsedSection["provenance"]>[number],
  field: Sanitize,
  where: string,
): Promise<AgentBriefingSection["provenance"][number]> {
  return { kind: entry.kind, ...(await storeJoinKey(entry.id, field, where)), version: entry.version, hash: entry.hash };
}

function prepareSection(
  section: ParsedSection,
  index: number,
  sanitize: VisibilitySanitizer,
  field: Sanitize,
): PreparedSection {
  const where = `section ${index} (${section.kind})`;
  const parts: ParsedPart[] =
    section.parts ??
    (section.text === ""
      ? []
      : [{ id: section.kind, title: section.title, origin: { kind: section.kind }, content: section.text }]);

  const joined = parts.map((part) => part.content).join("");
  if (joined !== section.text) throw new AgentVisibilityInputError(tilingMismatch(where, section.text, parts));

  for (const part of parts) {
    const at = `part "${part.id}" of ${where}`;
    if (part.withheld && (part.content !== "" || part.cut)) {
      throw new AgentVisibilityInputError(`The ${at} is withheld, so it sends nothing and is not cut.`);
    }
    if (part.cut && part.cut.originalLengthUtf16 <= part.content.length) {
      throw new AgentVisibilityInputError(
        `The ${at} says text was cut before sending, but its original length (${part.cut.originalLengthUtf16} UTF-16 units) is not above what was sent (${part.content.length}).`,
      );
    }
  }

  // Lone surrogates become U+FFFD across the whole section at once, because a
  // pair split between two parts is one character in the text the model read.
  const sent = wellFormed(section.text);
  let boundary = 0;
  for (const part of parts) {
    boundary += part.content.length;
    if (splitsSurrogatePair(sent, boundary)) {
      throw new AgentVisibilityInputError(
        `The part "${part.id}" of ${where} ends between the two halves of one character.`,
      );
    }
  }
  const redactedParts = redactSection(
    sent,
    parts.map((part) => part.content.length),
    sanitize,
    where,
  );

  const ids = uniquePartIds(parts.map((part) => part.id));
  const preparedParts: PreparedPart[] = [];
  const spans: AppliedSpan[] = [];
  let redacted = "";
  let redactedBytes = 0;
  let offset16 = 0;
  parts.forEach((part, position) => {
    const redactedPart = redactedParts[position]!;
    const at = `part "${ids[position]}" of ${where}`;
    for (const span of redactedPart.spans) {
      spans.push({
        start16: redacted.length + span.start16,
        end16: redacted.length + span.end16,
        startByte: redactedBytes + span.startByte,
        endByte: redactedBytes + span.endByte,
        kind: span.kind,
      });
    }
    const partBytes = utf8Length(redactedPart.text);
    preparedParts.push({
      input: part,
      id: ids[position]!,
      title: field(part.title, `the title of ${at}`),
      ...(part.origin.ref === undefined ? {} : { ref: field(part.origin.ref, `the origin of ${at}`) }),
      ...(part.origin.label === undefined ? {} : { label: field(part.origin.label, `the origin of ${at}`) }),
      ...(part.withheld ? { withheld: field(part.withheld.text, `the withheld rule of ${at}`) } : {}),
      sentBytes: utf8Length(sent, offset16, offset16 + part.content.length),
      controlCharactersStripped: redactedPart.controlCharactersStripped,
      start: redactedBytes,
      end: redactedBytes + partBytes,
    });
    offset16 += part.content.length;
    redacted += redactedPart.text;
    redactedBytes += partBytes;
  });

  return {
    input: section,
    index,
    title: field(section.title, `the title of ${where}`),
    sent,
    sentBytes: utf8Length(sent),
    redacted,
    redactedBytes,
    spans,
    parts: preparedParts,
  };
}

/** Says where the parts stop reproducing the text, by position only: an error
 *  message is logged, so it never quotes the text itself. */
function tilingMismatch(where: string, text: string, parts: readonly ParsedPart[]): string {
  const joined = parts.map((part) => part.content).join("");
  let at = 0;
  while (at < text.length && at < joined.length && text[at] === joined[at]) at += 1;
  let cursor = 0;
  const culprit = parts.find((part) => {
    cursor += part.content.length;
    return cursor > at;
  });
  return `The parts of ${where} do not reproduce its text: together they are ${joined.length} characters, the text is ${text.length}, and they first differ at character ${at}${culprit ? ` (inside part "${culprit.id}")` : ""}. Every character of a section belongs to exactly one part, in order.`;
}

/** A repeated id keeps its first occurrence bare and numbers the rest from 2,
 *  skipping any id the input already uses. */
function uniquePartIds(ids: readonly string[]): string[] {
  const used = new Set(ids);
  const seen = new Map<string, number>();
  return ids.map((id) => {
    const occurrence = (seen.get(id) ?? 0) + 1;
    seen.set(id, occurrence);
    if (occurrence === 1) return id;
    let ordinal = occurrence;
    while (used.has(`${id}.${ordinal}`)) ordinal += 1;
    const unique = `${id}.${ordinal}`;
    used.add(unique);
    return unique;
  });
}

/**
 * Bytes each section may keep so the total fits the budget.
 *
 * Tier by tier, and within a tier by water-filling: every section keeps the
 * same number of leading bytes, and a section shorter than that level stays
 * whole. That keeps small sections intact and cuts the large one, rather than
 * wiping whichever section happens to come last.
 */
function allocateStorage(entries: readonly { bytes: number; tier: number }[], budget: number): number[] {
  const allowed = entries.map((entry) => entry.bytes);
  let excess = allowed.reduce((total, bytes) => total + bytes, 0) - budget;
  for (const tier of [0, 1, 2]) {
    if (excess <= 0) break;
    const members = entries.flatMap((entry, index) => (entry.tier === tier ? [index] : []));
    const tierTotal = members.reduce((total, index) => total + entries[index]!.bytes, 0);
    if (tierTotal === 0) continue;
    if (excess >= tierTotal) {
      for (const index of members) allowed[index] = 0;
      excess -= tierTotal;
      continue;
    }
    const level = waterLevel(
      members.map((index) => entries[index]!.bytes),
      tierTotal - excess,
    );
    for (const index of members) allowed[index] = Math.min(entries[index]!.bytes, level);
    excess = 0;
  }
  return allowed;
}

/** The largest level L with sum(min(size, L)) <= target. */
function waterLevel(sizes: readonly number[], target: number): number {
  const sorted = [...sizes].sort((left, right) => left - right);
  let below = 0;
  for (let position = 0; position < sorted.length; position += 1) {
    const remaining = sorted.length - position;
    if (below + sorted[position]! * remaining >= target) {
      return Math.floor((target - below) / remaining);
    }
    below += sorted[position]!;
  }
  return sorted.at(-1) ?? 0;
}

async function storeSection(
  section: PreparedSection,
  allowedBytes: number,
  field: Sanitize,
): Promise<{ section: StoredSection; text: string }> {
  // The cut lands on a character boundary and never inside a replacement
  // marker, so a stored span is always whole.
  let cut = section.redactedBytes;
  if (allowedBytes < section.redactedBytes) {
    cut = utf8Length(section.redacted, 0, utf16IndexWithinBytes(section.redacted, allowedBytes));
    for (const span of section.spans) {
      if (span.startByte < cut && cut < span.endByte) cut = span.startByte;
    }
  }
  const text = section.redacted.slice(0, utf16IndexAtByte(section.redacted, cut) ?? 0);

  const parts = section.parts.map((part) => {
    const input = part.input;
    const loss =
      part.start === part.end || part.end <= cut ? "none" : part.start >= cut ? "whole" : "partial";
    const empty = input.content === "" && !input.withheld && !input.cut;
    return {
      prepared: part,
      id: part.id,
      sentBytes: part.sentBytes,
      cutBeforeSend: input.cut ? (input.content === "" ? ("whole" as const) : ("partial" as const)) : ("none" as const),
      ...(input.cut ? { cutCause: input.cut.cause, originalLengthUtf16: input.cut.originalLengthUtf16 } : {}),
      truncatedForStorage: loss,
      ...(empty ? { empty: true as const } : {}),
      ...(part.controlCharactersStripped > 0 ? { controlCharactersStripped: part.controlCharactersStripped } : {}),
      range: { start: Math.min(part.start, cut), end: Math.min(part.end, cut) },
    } satisfies StoredSection["parts"][number];
  });

  return {
    text,
    section: {
      prepared: section,
      fields: {
        index: section.index,
        kind: section.input.kind,
        provenance: await Promise.all(
          (section.input.provenance ?? [])
            .slice(0, AGENT_BRIEFING_PROVENANCE_MAX)
            .map((entry) => storeProvenance(entry, field, `the provenance of section ${section.index}`)),
        ),
        provenanceCount: section.input.provenance?.length ?? 0,
        sentBytes: section.sentBytes,
        sentSha256: await sha256Hex(section.sent),
        redactedBytes: section.redactedBytes,
        storedBytes: cut,
        storedSha256: await sha256Hex(text),
        truncatedForStorage: cut < section.redactedBytes,
        redactionCount: section.spans.length,
      },
      storedSpans: section.spans
        .filter((span) => span.endByte <= cut)
        .map((span) => ({ start: span.startByte, end: span.endByte, kind: span.kind })),
      parts,
    },
  };
}

/** A stored section with its free text cut to `cap` at most and at most
 *  `spanCap` spans listed. */
function renderSection(section: StoredSection, cap: number, spanCap: number): AgentBriefingSection {
  const clamp = (text: SanitizedText, max: number) => clampSanitized(text, Math.min(max, cap));
  const { index, kind, ...rest } = section.fields;
  const redactions = section.storedSpans.slice(0, Math.min(spanCap, AGENT_BRIEFING_SECTION_SPANS_MAX));
  return {
    index,
    kind,
    title: clamp(section.prepared.title, AGENT_VISIBILITY_TITLE_MAX_LENGTH),
    ...rest,
    redactionListComplete: redactions.length === section.storedSpans.length,
    redactions,
    parts: section.parts.map(({ prepared, ...part }) => ({
      id: part.id,
      title: clamp(prepared.title, AGENT_VISIBILITY_TITLE_MAX_LENGTH),
      origin: {
        kind: prepared.input.origin.kind,
        ...(prepared.ref ? { ref: clamp(prepared.ref, AGENT_VISIBILITY_LABEL_MAX_LENGTH) } : {}),
        ...(prepared.label ? { label: clamp(prepared.label, AGENT_VISIBILITY_LABEL_MAX_LENGTH) } : {}),
      },
      sentBytes: part.sentBytes,
      cutBeforeSend: part.cutBeforeSend,
      ...(part.cutCause === undefined ? {} : { cutCause: part.cutCause, originalLengthUtf16: part.originalLengthUtf16 }),
      truncatedForStorage: part.truncatedForStorage,
      ...(prepared.withheld
        ? {
            withheld: {
              reason: prepared.input.withheld!.reason,
              text: clamp(prepared.withheld, AGENT_VISIBILITY_MESSAGE_MAX_LENGTH),
            },
          }
        : {}),
      ...(part.empty ? { empty: part.empty } : {}),
      ...(part.controlCharactersStripped === undefined
        ? {}
        : { controlCharactersStripped: part.controlCharactersStripped }),
      range: part.range,
    })),
  };
}

/**
 * The repository context as the JSON document stored beside the section texts.
 *
 * Every description, rule, reason, note and rationale passes the sanitizer,
 * and is shortened, all to one common length, when the document would not fit
 * `AGENT_BRIEFING_CONTEXT_MAX_BYTES` whole. Keys are kept whole: a shortened
 * key would point at no repository.
 */
async function buildContextDocument(
  context: ParsedContext,
  sanitize: VisibilitySanitizer,
): Promise<{ text: string; sha256: string; bytes: number; redactions: number }> {
  const counter = { redactions: 0 };
  // Past the listing ceilings, the reference and each repository count what
  // the send described; a large catalog is never a reason to refuse a send.
  const repositories = context.repositories.slice(0, AGENT_BRIEFING_REPOSITORIES_MAX).map((repository): SanitizedRepository => {
    const where = `repository ${repository.key}`;
    const field = (text: string) => sanitizeText(text, sanitize, where, counter);
    const entry = repository.workScopeEntry;
    return {
      repository,
      description: field(repository.description.text),
      rules: repository.rules === null ? null : field(repository.rules),
      notes: repository.relationships
        .slice(0, AGENT_BRIEFING_RELATIONSHIPS_MAX)
        .map((relationship) => (relationship.note === undefined ? undefined : field(relationship.note))),
      reason: repository.reason === undefined ? undefined : field(repository.reason),
      rationale: entry ? field(entry.rationale) : undefined,
      actorLabel: entry?.decidedBy.actorLabel === undefined ? undefined : field(entry.decidedBy.actorLabel),
      model: entry?.decidedBy.model === undefined ? undefined : field(entry.decidedBy.model),
    };
  });

  const render = (cap: number): AgentBriefingRepositoryContext => {
    const clamp: Clamp = (text, max) => clampSanitized(text, Math.min(max, cap));
    return {
      schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
      repositories: repositories.map((sanitized) => renderRepository(sanitized, clamp)),
      unlistedCount: context.unlistedCount,
      workScope: context.workScope
        ? { version: context.workScope.version, leftOutKeys: context.workScope.leftOutKeys.slice(0, AGENT_BRIEFING_REPOSITORIES_MAX) }
        : null,
    };
  };

  const document = fitToBound(
    render,
    AGENT_BRIEFING_REPOSITORY_TEXT_MAX_LENGTH,
    AGENT_BRIEFING_CONTEXT_MAX_BYTES,
    () =>
      `The repository context of ${context.repositories.length} repositories does not fit in ${AGENT_BRIEFING_CONTEXT_MAX_BYTES} bytes even with every description, rule and reason shortened to ${FREE_TEXT_FLOOR} characters.`,
  );
  const check = agentBriefingRepositoryContextSchema.safeParse(document);
  if (!check.success) {
    throw new Error(
      `The built repository context does not satisfy its own schema: ${describeIssues(check.error.issues)}`,
    );
  }
  const text = JSON.stringify(document);
  return { text, sha256: await sha256Hex(text), bytes: utf8Length(text), redactions: counter.redactions };
}

type Clamp = (text: SanitizedText, max: number) => string;

/** A repository of the context with its free text through the sanitizer and
 *  not yet shortened. */
interface SanitizedRepository {
  repository: ParsedContext["repositories"][number];
  description: SanitizedText;
  rules: SanitizedText | null;
  notes: (SanitizedText | undefined)[];
  reason: SanitizedText | undefined;
  rationale: SanitizedText | undefined;
  actorLabel: SanitizedText | undefined;
  model: SanitizedText | undefined;
}

function renderRepository(sanitized: SanitizedRepository, clamp: Clamp): AgentBriefingRepository {
  const repository = sanitized.repository;
  const entry = repository.workScopeEntry;
  const actor = entry?.decidedBy;
  return {
    key: repository.key,
    description: {
      source: repository.description.source,
      text: clamp(sanitized.description, AGENT_BRIEFING_REPOSITORY_TEXT_MAX_LENGTH),
    },
    rules: sanitized.rules === null ? null : clamp(sanitized.rules, AGENT_BRIEFING_REPOSITORY_TEXT_MAX_LENGTH),
    relationships: repository.relationships
      .slice(0, AGENT_BRIEFING_RELATIONSHIPS_MAX)
      .map((relationship, position) => renderRelationship(relationship, sanitized.notes[position], clamp)),
    relationshipCount: repository.relationships.length,
    state: repository.state,
    ...(sanitized.reason === undefined ? {} : { reason: clamp(sanitized.reason, AGENT_VISIBILITY_MESSAGE_MAX_LENGTH) }),
    inclusion: {
      cause: repository.inclusion.cause,
      ...(repository.inclusion.via
        ? { via: { key: repository.inclusion.via.key, relationship: repository.inclusion.via.relationship } }
        : {}),
    },
    rendering: repository.rendering,
    workScopeEntry:
      entry && actor && sanitized.rationale
        ? {
            repositoryKey: entry.repositoryKey,
            state: entry.state,
            ...(entry.unavailableReason === undefined ? {} : { unavailableReason: entry.unavailableReason }),
            origin: entry.origin,
            rationale: clamp(sanitized.rationale, AGENT_VISIBILITY_MESSAGE_MAX_LENGTH),
            decidedBy: {
              kind: actor.kind,
              ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
              ...(sanitized.actorLabel === undefined
                ? {}
                : { actorLabel: clamp(sanitized.actorLabel, AGENT_VISIBILITY_LABEL_MAX_LENGTH) }),
              ...(actor.runId === undefined ? {} : { runId: actor.runId }),
              ...(actor.definitionId === undefined ? {} : { definitionId: actor.definitionId }),
              ...(actor.definitionVersion === undefined ? {} : { definitionVersion: actor.definitionVersion }),
              ...(sanitized.model === undefined ? {} : { model: clamp(sanitized.model, AGENT_VISIBILITY_LABEL_MAX_LENGTH) }),
            },
            decidedAt: entry.decidedAt,
          }
        : null,
  };
}

function renderRelationship(
  relationship: ParsedContext["repositories"][number]["relationships"][number],
  note: SanitizedText | undefined,
  clamp: Clamp,
): AgentBriefingRepository["relationships"][number] {
  return {
    kind: relationship.kind,
    target: relationship.target,
    ...(relationship.direction === undefined ? {} : { direction: relationship.direction }),
    ...(note === undefined ? {} : { note: clamp(note, AGENT_VISIBILITY_LABEL_MAX_LENGTH) }),
  };
}
