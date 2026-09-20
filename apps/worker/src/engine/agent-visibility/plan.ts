/**
 * What one send will record, decided in WORKFLOW SCOPE.
 *
 * This half is pure: it turns a compilation (or a list of prompt parts, or a
 * bare prompt) into the small, describing argument the send step carries. It
 * touches no database, no clock and no environment, because it runs inside the
 * workflow isolate, which may do none of those and must replay to the same
 * bytes. The step-side half is `capture.ts`, reached by a deferred import from
 * inside the step body.
 *
 * THE ARGUMENT NEVER CARRIES THE PROMPT AGAIN. The send step already holds the
 * prompt and the wrapper script as arguments, and the Workflow DevKit writes
 * every step argument into the run's event log; a second copy of a 300 KB
 * prompt per send is what has cost this repository runs to
 * `CORRUPTED_EVENT_LOG` before. So a section travels as a byte range into the
 * text the step already has, and a part as its length inside that range.
 */
import type {
  EffectivePromptCompilation,
  EffectivePromptPart,
  EffectivePromptSection,
} from "@shared/prompts";
import type { WorkScopeEntry } from "@shared/contracts";

/** Where a recorded section's text is, in the text the step already holds. */
export type BriefingTextSource = "prompt" | "system";

/** One named piece of a section, as a length inside the section's range. */
export interface BriefingPartPlan {
  id: string;
  title: string;
  origin: { kind: string; ref?: string; label?: string };
  /** UTF-16 units this part takes of its section's text, in order. */
  length: number;
  /** Text this part lost before the agent saw it. */
  cut?: { originalLengthUtf16: number; cause: string };
  /** A platform rule held back on purpose. The text travels because it is not
   *  in the prompt: it was never sent. */
  withheld?: { reason: string; text: string };
}

export interface BriefingSectionPlan {
  kind: string;
  title: string;
  provenance?: { kind: string; id: string; version: number | null; hash: string }[];
  /** A half-open UTF-16 range `[start, end)` in the named text. */
  text: { source: BriefingTextSource; start: number; end: number };
  /** Absent: the whole section is one part named after its kind. */
  parts?: BriefingPartPlan[];
}

export interface BriefingRepositoryPlan {
  key: string;
  description: { source: string; text: string };
  rules: string | null;
  relationships: { kind: string; target: string; direction?: string; note?: string }[];
  state: string;
  reason?: string;
  inclusion: { cause: string; via?: { key: string; relationship: string } };
  rendering: string;
  workScopeEntry: WorkScopeEntry | null;
}

export interface BriefingRepositoryContextPlan {
  repositories: BriefingRepositoryPlan[];
  unlistedCount: number;
  workScope: { version: number; leftOutKeys: string[] } | null;
  renderedAt?: { sectionIndex: number; partId: string };
}

/**
 * The whole argument one send step carries for capture.
 *
 * `capturedAt` is deliberately NOT here: the step stamps it, so this object is
 * the same bytes on a replay as on the first execution, and the stored record
 * compares content with the capture time left out anyway.
 */
export interface AgentBriefingCapture {
  /** False records the send as "capture was off" instead of a briefing. Read
   *  from the settings the run froze at its start, never from the store. */
  enabled: boolean;
  identity: {
    runId: string;
    nodeId: string;
    attempt: number;
    activationScopeId: string;
    sequence: number;
    kind: "discovery" | "agent" | "llm";
    blockType: string;
    passLabel?: string;
  };
  harness: {
    provider: string;
    model: string;
    outputSchema?: string | null;
    skills?: { id: string; version?: number; sha256?: string }[];
    profile?: { id: string; version: number } | null;
    includeWorkflowData?: boolean;
    includeRepositoryInstructions?: boolean;
  };
  sections: BriefingSectionPlan[];
  repositoryContext?: BriefingRepositoryContextPlan | null;
  unresolvedSources?: { kind: string; reference: string; message: string }[];
}

/**
 * What the argument may cost in the journal.
 *
 * No byte cap on a step argument was found in `@workflow/core`, so this is our
 * own budget, set the way `engine/steps/pre-pr-checks-runner.ts` sets its own:
 * the prompt beside it is already hundreds of kilobytes, and the describing
 * data must stay a rounding error on top of it rather than a second prompt.
 */
export const BRIEFING_CAPTURE_MAX_BYTES = 64 * 1024;

/** The kinds `AGENT_BRIEFING_CUT_CAUSES` knows; anything else is recorded as
 *  the compiler's own cap, which is the only other cut that exists today. */
const DEFAULT_CUT_CAUSE = "section_cap";

const SECTION_SEPARATOR = "\n\n";

export interface BriefingSequence {
  /** The next send of this Block Attempt. Called in workflow scope, in the
   *  order the sends really happen. */
  next(): number;
}

/**
 * One counter per BLOCK ATTEMPT, shared by every kind of send.
 *
 * Per attempt, because a planning attempt sends many times (a pass, a
 * discovery it triggers, another pass) and the attempt number is fixed for the
 * whole execution. Never per node and never per module: two runs in one worker
 * instance reach the same node id, and a counter they shared would hand the
 * same identity to two different sends, where the insert's
 * `ON CONFLICT DO NOTHING` drops one of them without a sound. Never per kind
 * either, for the same reason within one attempt.
 *
 * Incremented in the workflow body, so a resumed run re-executing earlier
 * passes from the journal computes the same number for the pass it is about to
 * send as the first execution did.
 */
export function createBriefingSequence(): BriefingSequence {
  let sent = 0;
  return {
    next() {
      sent += 1;
      return sent;
    },
  };
}

/** What a send is, before anything is said about its prompt. */
export interface BriefingIdentity {
  enabled: boolean;
  runId: string;
  nodeId: string;
  blockType: string;
  attempt: number;
  activationScopeId: string;
  sequence: number;
}

interface CommonPlanInput extends BriefingIdentity {
  passLabel?: string;
  harness: AgentBriefingCapture["harness"];
  repositoryContext?: BriefingRepositoryContextPlan | null;
}

/**
 * The part of the invocation a send needs to name itself. Spelled
 * structurally rather than as `BlockInvocationContext`, so the pure half of
 * capture does not import the worker's block types back.
 */
export interface BriefingInvocation {
  nodeId: string;
  blockType: string;
  attempt?: number;
  activationScopeId?: string;
  briefingSequence: BriefingSequence;
}

/**
 * Take the next place in this Block Attempt's order, for the send about to
 * happen.
 *
 * CALL IT EXACTLY ONCE PER SEND, at the send. The order of the calls is the
 * order of the sends: a planning attempt that sends a pass, then triggers
 * discovery, then sends again records 1, 2, 3 in that order, and nothing here
 * assumes discovery comes first.
 *
 * `enabled` comes from the settings the run froze at its start, never from the
 * store, so a switch flipped mid-run cannot make a replayed branch record
 * something different from what it recorded the first time.
 */
export function nextBriefingIdentity(
  execution: BriefingInvocation | undefined,
  run: { runId: string; enabled: boolean },
): BriefingIdentity | null {
  if (!execution) return null;
  return {
    enabled: run.enabled,
    runId: run.runId,
    // Shortened, not refused: a loop around a long-named node builds a scope
    // id past the contract's bound, and refusing there would lose every send
    // inside that loop.
    nodeId: shortenVisibilityId(execution.nodeId),
    blockType: execution.blockType,
    attempt: execution.attempt ?? 1,
    activationScopeId: shortenVisibilityId(execution.activationScopeId ?? "root"),
    sequence: execution.briefingSequence.next(),
  };
}

/**
 * The plan for a send whose prompt a compilation produced.
 *
 * Sections are located rather than copied, and the location is VERIFIED: the
 * compiler renders each section between sentinels and joins them with a blank
 * line (`packages/prompts/effective-prompt.ts`, `renderSection`), and this
 * mirrors that. A mirror can go stale, so every range is checked against the
 * prompt before it is used, and a prompt this cannot take apart is recorded
 * whole and unattributed instead of silently losing its text.
 */
export function planCompiledBriefing(
  input: CommonPlanInput & {
    kind: "agent" | "llm";
    prompt: string;
    compilation: EffectivePromptCompilation;
  },
): AgentBriefingCapture {
  // Capture is off, so nothing about the prompt is described or journaled:
  // the send is recorded as a marker and the argument stays tiny.
  if (!input.enabled) return markerOnly(input);
  return safely(input, () => compiledPlan(input));
}

/**
 * Planning a briefing may never fail a run, and may never lose the run with it.
 *
 * This half runs in the workflow body, outside the step's own guard, so a
 * throw here would take down a run for the sake of the record of it. Returning
 * nothing would be almost as bad: the step would then write no marker, never
 * reach the only writer of the run's per-run fact, and the run would read as
 * one from before capture existed. So a failed plan falls back to the smallest
 * honest record there is: this send's identity, and the exact bytes that went,
 * unattributed.
 */
function safely(
  input: CommonPlanInput & { kind: AgentBriefingCapture["identity"]["kind"]; prompt: string },
  plan: () => AgentBriefingCapture,
): AgentBriefingCapture {
  try {
    return plan();
  } catch (error) {
    // console, not the logger: workflow scope has no logger import. The
    // identity travels with it, because this fires for every send at once when
    // it fires at all, and a line nobody can trace to a run is a line nobody
    // acts on.
    console.error("agent_briefing_plan_failed", {
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      sequence: input.sequence,
      error,
    });
    return {
      enabled: input.enabled,
      identity: identityOf(input, input.kind),
      harness: input.harness,
      sections: [unattributedSection("block", "Prompt as sent", input.prompt)],
      unresolvedSources: [
        {
          kind: "prompt",
          reference: `node:${input.nodeId}`,
          message: "This send could not be described, so only the prompt it sent is on the record.",
        },
      ],
    };
  }
}

/**
 * Capture is off, so there is nothing to describe.
 *
 * The send is still numbered and still recorded, as a marker saying capture
 * was off, because four sends have to read as four. Building the section index
 * first would journal a description of a prompt nobody will ever be shown.
 */
function markerOnly(input: CommonPlanInput & { kind: AgentBriefingCapture["identity"]["kind"] }): AgentBriefingCapture {
  return {
    enabled: false,
    identity: identityOf(input, input.kind),
    harness: input.harness,
    sections: [],
  };
}

/**
 * The longest an id may be on a briefing, and how one too long is shortened.
 *
 * The scheduler builds a loop's activation scope as
 * `${ownerScopeId}/loop:${node.id}:${iteration}` and nests it per level, while
 * a node id is legal up to 200 characters, so one loop around a long-named
 * node already passes the contract's own bound. Refusing there would lose
 * every send inside that loop, which is the opposite of what this feature is
 * for, so an id too long is SHORTENED deterministically instead: a readable
 * head, a tilde, and a hash of the whole id.
 *
 * THE SAME TRANSFORM HAS TO RUN ON ANY FILTER THAT JOINS ON THESE IDS, because
 * a reader filtering by the full scope id would otherwise match nothing.
 */
const VISIBILITY_ID_MAX = 200;
const VISIBILITY_ID_HEAD = 150;

/** FNV-1a, 32 bits, over the CODE POINTS of the string, so the same id hashes
 *  the same wherever it is recomputed. Synchronous and pure, because workflow
 *  scope has neither async hashing nor a Node module. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (const character of text) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * `id` unchanged when it fits, else its first 150 characters, a `~`, and two
 * FNV-1a passes over the code points of the WHOLE id (offset basis then
 * prime as the seed) as 16 lower-case hex characters. At most 167
 * characters.
 */
export function shortenVisibilityId(id: string): string {
  if (id.length <= VISIBILITY_ID_MAX) return id;
  let head = VISIBILITY_ID_HEAD;
  // Never cut between the two halves of one character: a code point above the
  // basic plane starting one before the cut is exactly that case.
  const straddling = id.codePointAt(head - 1);
  if (straddling !== undefined && straddling > 0xffff) head -= 1;
  const digest = `${fnv1a32(id, 0x811c9dc5).toString(16).padStart(8, "0")}${fnv1a32(id, 0x01000193)
    .toString(16)
    .padStart(8, "0")}`;
  return `${id.slice(0, head)}~${digest}`;
}

function compiledPlan(
  input: CommonPlanInput & {
    kind: "agent" | "llm";
    prompt: string;
    compilation: EffectivePromptCompilation;
  },
): AgentBriefingCapture {
  const notes: AgentBriefingCapture["unresolvedSources"] =
    input.compilation.unresolvedSources.map((source) => ({
      kind: source.kind,
      reference: source.reference,
      message: source.message,
    }));
  const ranges = locateSections(input.prompt, input.compilation.sections);
  const sections: BriefingSectionPlan[] = [];
  if (ranges) {
    input.compilation.sections.forEach((section, index) => {
      sections.push(planSection(section, ranges[index]!, notes, index));
    });
  } else {
    notes.push({
      kind: "prompt",
      reference: `node:${input.nodeId}`,
      message:
        "The compiled sections could not be located in the prompt that was sent, so it is recorded whole and unattributed.",
    });
    sections.push(unattributedSection("block", "Prompt as sent", input.prompt));
  }
  // The runtime section the compiler did not render, so what it held back is
  // still on the record. Dropping it hides the case that confuses people most:
  // a profile with workflow data off, whose prompt simply has no ticket in it.
  const unrendered = input.compilation.unrenderedRuntimeParts;
  if (unrendered.length > 0) {
    const planned = unrendered.map((part) => planPart(part, notes, sections.length));
    const parts = planned.filter((part) => part.length === 0);
    // A part in this list is meant to be zero bytes: it is a rule held back or
    // a part cut whole. One carrying text would belong to a section that was
    // never rendered, and its bytes are in no range this record can point at,
    // so it is reported rather than dropped.
    for (const carried of planned.filter((part) => part.length > 0)) {
      notes.push({
        kind: "prompt",
        reference: `part:${carried.id}`,
        message: `Part "${carried.id}" was not sent and yet carries text, so it is not on this record.`,
      });
    }
    if (parts.length > 0) {
      sections.push({
        kind: "runtime",
        title: "Runtime data that was not sent",
        text: { source: "prompt", start: input.prompt.length, end: input.prompt.length },
        parts,
      });
    }
  }
  const profile = input.compilation.profileContext;
  return bound(
    {
    enabled: input.enabled,
    identity: identityOf(input, input.kind),
    harness: {
      ...input.harness,
      ...(profile
        ? {
            includeWorkflowData: profile.includeWorkflowData,
            includeRepositoryInstructions: profile.includeRepositoryInstructions,
          }
        : {}),
    },
    sections,
    ...(input.repositoryContext
      ? { repositoryContext: keepRenderedAt(input.repositoryContext, sections) }
      : {}),
    ...(notes.length > 0 ? { unresolvedSources: notes } : {}),
    },
    input.prompt.length,
  );
}

/**
 * The plan for a send whose prompt is one section made of named parts.
 *
 * Repository discovery is the only one: it runs on the legacy harness path
 * with no compiler, and composes its prompt out of the same part type
 * (`engine/repository-discovery/runner.ts`), so the parts tile the prompt
 * itself rather than a section of it.
 */
export function planPartsBriefing(
  input: CommonPlanInput & {
    kind: "discovery" | "agent" | "llm";
    sectionKind: string;
    sectionTitle: string;
    prompt: string;
    parts: readonly EffectivePromptPart[];
  },
): AgentBriefingCapture {
  // Capture is off, so nothing about the prompt is described or journaled:
  // the send is recorded as a marker and the argument stays tiny.
  if (!input.enabled) return markerOnly(input);
  return safely(input, () => partsPlan(input));
}

function partsPlan(
  input: CommonPlanInput & {
    kind: "discovery" | "agent" | "llm";
    sectionKind: string;
    sectionTitle: string;
    prompt: string;
    parts: readonly EffectivePromptPart[];
  },
): AgentBriefingCapture {
  const notes: AgentBriefingCapture["unresolvedSources"] = [];
  const section = planSection(
    {
      kind: input.sectionKind,
      title: input.sectionTitle,
      content: input.prompt,
      provenance: [],
      parts: [...input.parts],
    },
    { start: 0, end: input.prompt.length },
    notes,
    0,
  );
  return bound(
    {
    enabled: input.enabled,
    identity: identityOf(input, input.kind),
    harness: input.harness,
    sections: [section],
    ...(input.repositoryContext
      ? { repositoryContext: keepRenderedAt(input.repositoryContext, [section]) }
      : {}),
    ...(notes.length > 0 ? { unresolvedSources: notes } : {}),
    },
    input.prompt.length,
  );
}

/**
 * The plan for a send nothing composed: an in-process model call whose prompt
 * came from a bound input or a block parameter.
 *
 * One honest unattributed section over the exact bytes that went, and a second
 * one for a system prompt. Never a briefing with no sections, which reads to a
 * person as "the agent got nothing".
 */
export function planTextBriefing(
  input: CommonPlanInput & {
    kind: "llm" | "agent";
    prompt: string;
    system?: string | undefined;
  },
): AgentBriefingCapture {
  // Capture is off, so nothing about the prompt is described or journaled:
  // the send is recorded as a marker and the argument stays tiny.
  if (!input.enabled) return markerOnly(input);
  return safely(input, () => textPlan(input));
}

function textPlan(
  input: CommonPlanInput & {
    kind: "llm" | "agent";
    prompt: string;
    system?: string | undefined;
  },
): AgentBriefingCapture {
  const sections: BriefingSectionPlan[] = [];
  if (input.system !== undefined && input.system.length > 0) {
    sections.push({
      kind: "system",
      title: "System prompt",
      text: { source: "system", start: 0, end: input.system.length },
    });
  }
  sections.push(unattributedSection("block", "Prompt as sent", input.prompt));
  return bound(
    {
    enabled: input.enabled,
    identity: identityOf(input, input.kind),
    harness: input.harness,
    sections,
    ...(input.repositoryContext ? { repositoryContext: input.repositoryContext } : {}),
    },
    input.prompt.length,
  );
}

/**
 * Where the map text was rendered, but only while that part still exists.
 *
 * A section whose parts did not tile its text is recorded unattributed, and a
 * `renderedAt` still pointing into it would make the builder refuse the whole
 * briefing, turning "recorded whole and unattributed" into a marker with no
 * text at all. Discovery always points at section 0, which is exactly the
 * section that fallback strips.
 */
function keepRenderedAt(
  context: BriefingRepositoryContextPlan,
  sections: readonly BriefingSectionPlan[],
): BriefingRepositoryContextPlan {
  const at = context.renderedAt;
  if (!at) return context;
  const parts = sections[at.sectionIndex]?.parts;
  if (parts?.some((part) => part.id === at.partId)) return context;
  const { renderedAt: _dropped, ...rest } = context;
  return rest;
}

function identityOf(
  input: CommonPlanInput,
  kind: AgentBriefingCapture["identity"]["kind"],
): AgentBriefingCapture["identity"] {
  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    activationScopeId: input.activationScopeId,
    sequence: input.sequence,
    kind,
    blockType: input.blockType,
    ...(input.passLabel === undefined ? {} : { passLabel: input.passLabel }),
  };
}

function unattributedSection(kind: string, title: string, text: string): BriefingSectionPlan {
  return { kind, title, text: { source: "prompt", start: 0, end: text.length } };
}

/**
 * Where each rendered section's text sits in the prompt.
 *
 * Returns null the moment the prompt does not look the way the compiler builds
 * it, which is the only way a change to `renderSection` can reach a person as
 * anything but silence.
 */
function locateSections(
  prompt: string,
  sections: readonly EffectivePromptSection[],
): { start: number; end: number }[] | null {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (const [index, section] of sections.entries()) {
    const marker = section.kind.toUpperCase();
    const header = `<<<AI_WORKFLOW_${marker}_BEGIN: ${section.title}>>>\n`;
    const footer = `\n<<<AI_WORKFLOW_${marker}_END>>>`;
    const start = offset + header.length;
    const end = start + section.content.length;
    if (prompt.slice(offset, start) !== header) return null;
    if (prompt.slice(start, end) !== section.content) return null;
    if (prompt.slice(end, end + footer.length) !== footer) return null;
    ranges.push({ start, end });
    offset = end + footer.length;
    if (index < sections.length - 1) {
      if (prompt.slice(offset, offset + SECTION_SEPARATOR.length) !== SECTION_SEPARATOR) return null;
      offset += SECTION_SEPARATOR.length;
    }
  }
  return offset === prompt.length ? ranges : null;
}

function planSection(
  section: Omit<Pick<EffectivePromptSection, "kind" | "title" | "content" | "provenance" | "parts">, "kind"> & {
    kind: string;
  },
  range: { start: number; end: number },
  notes: NonNullable<AgentBriefingCapture["unresolvedSources"]>,
  index: number,
): BriefingSectionPlan {
  const base: BriefingSectionPlan = {
    kind: section.kind,
    title: section.title,
    ...(section.provenance.length > 0 ? { provenance: section.provenance } : {}),
    text: { source: "prompt", start: range.start, end: range.end },
  };
  const parts = section.parts;
  if (parts.length === 0) return base;
  // Every character of a section belongs to exactly one part, and the builder
  // refuses a section whose parts say otherwise. A section that fails the
  // check is recorded whole instead: the text a person reads is still exactly
  // what was sent, and the note says why it lost its attribution.
  const tiled = parts.reduce((total, part) => total + part.content.length, 0);
  if (tiled !== section.content.length) {
    notes.push({
      kind: "prompt",
      reference: `section:${index}`,
      message: `The parts of this section cover ${tiled} of its ${section.content.length} characters, so it is recorded unattributed.`,
    });
    return base;
  }
  return { ...base, parts: parts.map((part) => planPart(part, notes, index)) };
}

function planPart(
  part: EffectivePromptPart,
  notes: NonNullable<AgentBriefingCapture["unresolvedSources"]>,
  index: number,
): BriefingPartPlan {
  const plan: BriefingPartPlan = {
    id: part.id,
    title: part.title,
    origin: {
      kind: part.origin.kind,
      ...(part.origin.ref === undefined ? {} : { ref: part.origin.ref }),
      ...(part.origin.label === undefined ? {} : { label: part.origin.label }),
    },
    length: part.content.length,
  };
  // A withheld rule sends nothing, so it cannot also be cut. Guarded rather
  // than trusted: the builder refuses the pair outright, and one malformed
  // part would take the whole briefing down to a marker.
  if (part.withheld && part.content.length === 0) {
    return { ...plan, withheld: { reason: part.withheld.reason, text: part.withheld.text } };
  }
  if (part.cutBeforeSend === undefined) return plan;
  const original = part.originalLengthUtf16;
  if (original === undefined || original <= part.content.length) {
    notes.push({
      kind: "prompt",
      reference: `part:${part.id}`,
      message: `Part "${part.id}" of section ${index} says text was cut before sending without saying how much, so the cut is not recorded.`,
    });
    return plan;
  }
  return { ...plan, cut: { originalLengthUtf16: original, cause: part.cutCause ?? DEFAULT_CUT_CAUSE } };
}

/**
 * Keep the argument inside its budget, giving way in the order that costs a
 * reader least: the structured repository context first, because every
 * repository it names is also in the prompt text the record keeps; then the
 * part index, which costs attribution but no text; and only then everything
 * but the prompt itself. Each step says so on the record.
 */
/** How many repositories survive the first concession, before the list goes. */
const BUDGET_REPOSITORIES_KEPT = 40;

function note(capture: AgentBriefingCapture, message: string) {
  return { kind: "prompt", reference: `node:${capture.identity.nodeId}`, message };
}

/**
 * Keep the argument inside its budget, giving way in the order that costs a
 * reader least, and ALWAYS ending inside it.
 *
 * The repository list shortens before it disappears, because "why did it not
 * look at my repository" is asked about exactly the runs with many of them;
 * then the part index, which costs attribution but no text; then the harness
 * extras; and finally everything but one range over the prompt itself, which
 * is the smallest record that still shows a person what was sent. Each step
 * says on the record that it happened.
 */
function bound(capture: AgentBriefingCapture, promptLength: number): AgentBriefingCapture {
  if (withinBudget(capture)) return capture;
  const notes = [...(capture.unresolvedSources ?? [])];

  const context = capture.repositoryContext;
  if (context && context.repositories.length > BUDGET_REPOSITORIES_KEPT) {
    notes.push(
      note(
        capture,
        `Of ${context.repositories.length} repositories in scope, the first ${BUDGET_REPOSITORIES_KEPT} are on this record: describing the send did not fit its budget.`,
      ),
    );
    const shortened: AgentBriefingCapture = {
      ...capture,
      repositoryContext: {
        ...context,
        repositories: context.repositories.slice(0, BUDGET_REPOSITORIES_KEPT),
        unlistedCount:
          context.unlistedCount + (context.repositories.length - BUDGET_REPOSITORIES_KEPT),
      },
      unresolvedSources: notes,
    };
    if (withinBudget(shortened)) return shortened;
  }

  notes.push(
    note(capture, "The repositories in scope were left out of this record: describing the send did not fit its budget."),
  );
  const withoutContext: AgentBriefingCapture = {
    ...capture,
    repositoryContext: null,
    unresolvedSources: notes,
  };
  if (withinBudget(withoutContext)) return withoutContext;

  notes.push(
    note(capture, "Where each piece of this prompt came from was left out: describing the send did not fit its budget."),
  );
  const withoutParts: AgentBriefingCapture = {
    ...withoutContext,
    sections: withoutContext.sections.map(({ parts: _parts, ...section }) => section),
    unresolvedSources: notes,
  };
  if (withinBudget(withoutParts)) return withoutParts;

  // The output schema and the pinned skills are the two harness fields that can
  // be large, and both are recoverable from the profile and the wrapper script
  // the step keeps.
  notes.push(
    note(capture, "The output schema and pinned skills were left out: describing the send did not fit its budget."),
  );
  const { outputSchema: _schema, skills: _skills, ...harness } = withoutParts.harness;
  const withoutExtras: AgentBriefingCapture = { ...withoutParts, harness, unresolvedSources: notes };
  if (withinBudget(withoutExtras)) return withoutExtras;

  // Two hundred section titles with their provenance hashes can still be over
  // the budget on their own, so the last step is not another concession: it is
  // the floor. One range over everything that was sent, and one note.
  return {
    ...withoutExtras,
    // Everything that was sent, in one range: the sections are gone, so the
    // range has to cover the prompt itself rather than where the last section
    // happened to end.
    sections: [
      { kind: "block", title: "Prompt as sent", text: { source: "prompt", start: 0, end: promptLength } },
    ],
    unresolvedSources: [
      note(capture, "Only the prompt this send made is on the record: describing it did not fit its budget."),
    ],
  };
}

function withinBudget(capture: AgentBriefingCapture): boolean {
  return new TextEncoder().encode(JSON.stringify(capture)).length <= BRIEFING_CAPTURE_MAX_BYTES;
}

/**
 * A send whose prompt only exists inside the step that makes it.
 *
 * `leak_review` and the repo-memory distill compose their prompt from material
 * the step gathers, so there is nothing in workflow scope to point a range at.
 * The workflow body still takes the send's place in the order, and the step
 * finishes the record with `planDeferredBriefing`.
 */
export interface DeferredBriefing {
  identity: BriefingIdentity;
  harness: AgentBriefingCapture["harness"];
  passLabel?: string;
}

export function planDeferredBriefing(
  send: DeferredBriefing | null | undefined,
  texts: { prompt: string; system?: string | undefined },
): AgentBriefingCapture | null {
  if (!send) return null;
  return planTextBriefing({
    ...send.identity,
    ...(send.passLabel === undefined ? {} : { passLabel: send.passLabel }),
    kind: "llm",
    harness: send.harness,
    prompt: texts.prompt,
    system: texts.system,
  });
}

/**
 * Hand one send's record to the step-side writer, and never let doing so cost
 * the run.
 *
 * `load` is the caller's own dynamic import, so each step file keeps its own
 * relative path and the bundler still resolves it statically. It is called
 * inside the guard because the module itself can fail to load cold, and that
 * would happen to every send on a deployment at once, which is why the run and
 * the send travel in the log line.
 */
export async function recordSendBriefing(
  briefing: AgentBriefingCapture | null | undefined,
  texts: { prompt: string; system?: string | undefined; wrapperScript?: string | null },
  load: () => Promise<BriefingWriters>,
): Promise<void> {
  if (!briefing) return;
  try {
    const { captureAgentBriefing } = await load();
    await captureAgentBriefing(briefing, texts);
  } catch (error) {
    console.error("agent_briefing_capture_unavailable", {
      runId: briefing.identity.runId,
      nodeId: briefing.identity.nodeId,
      attempt: briefing.identity.attempt,
      sequence: briefing.identity.sequence,
      error,
    });
  }
}

/**
 * What the step-side writer must provide, described here rather than imported.
 *
 * `capture.ts` names this module for its types, so naming it back would make
 * the two a cycle (`scripts/gates/boundaries.mjs`). Each step file passes its
 * own `() => import("./capture.js")`, which is what keeps the path resolvable
 * from that file.
 */
export interface BriefingWriters {
  captureAgentBriefing: (
    briefing: AgentBriefingCapture,
    texts: { prompt: string; system?: string | undefined; wrapperScript?: string | null },
  ) => Promise<unknown>;
  captureSkippedSend: (briefing: AgentBriefingCapture, reason: string) => Promise<unknown>;
}

/** The same guard as `recordSendBriefing`, for a send that never went out. */
export async function recordSkippedSend(
  briefing: AgentBriefingCapture | null | undefined,
  load: () => Promise<BriefingWriters>,
  reason = "The send step failed before it launched anything.",
): Promise<void> {
  if (!briefing) return;
  try {
    const { captureSkippedSend } = await load();
    await captureSkippedSend(briefing, reason);
  } catch (error) {
    console.error("agent_briefing_capture_unavailable", {
      runId: briefing.identity.runId,
      nodeId: briefing.identity.nodeId,
      attempt: briefing.identity.attempt,
      sequence: briefing.identity.sequence,
      error,
    });
  }
}
