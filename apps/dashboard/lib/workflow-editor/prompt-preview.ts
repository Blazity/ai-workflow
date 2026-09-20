/**
 * What the worker's prompt preview says about the run it is a claim about.
 *
 * A preview is a promise with a delay on it, and the three things that used to
 * be invisible on this screen are the ones that break the promise: the profile
 * switches that decide which sections a run composes at all, the unresolved
 * values that STOP a run instead of being filled in, and the sections only a
 * prepared workspace can produce. The worker now reports all three
 * (`apps/worker/src/services/workflow-definitions/prompt-preview.ts`), and the
 * words for them live here so they can be read without rendering anything.
 *
 * THE WORKER DEPLOYS SEPARATELY. Everything here is optional at run time: a
 * worker from before this contract simply says nothing, and the screen must
 * fall back to what it used to claim rather than invent a switch position.
 */

/** The two switches execution reads before it composes a prompt. */
export interface PreviewContext {
  includeWorkflowData: boolean;
  includeRepositoryInstructions: boolean;
}

export interface PreviewProfile {
  profileId: string;
  version: number;
  name: string;
  /** `selected`: the profile this block names. `builtin`: the provider default
   *  a run would use, because the block names none. */
  applied: string;
}

/** Which of three things happens to an unresolved source when the block runs. */
export type SourceFate = "fatal" | "at_run" | "not_here" | "unsaid";

/**
 * A run stops at a `fails_the_run` source instead of calling the agent, and the
 * value shown in its place is one the preview made up. That is the difference
 * this whole screen is for, so an `atRun` this build does not know is NEVER
 * read as harmless: it says nothing and shows the worker's own message.
 */
export function sourceFate(atRun: string | undefined): SourceFate {
  switch (atRun) {
    case "fails_the_run":
      return "fatal";
    case "filled_at_run":
      return "at_run";
    case "not_in_preview":
      return "not_here";
    default:
      return "unsaid";
  }
}

/** Which profile this prompt was compiled with, in one line. */
export function profileLine(profile: PreviewProfile | null | undefined): string {
  if (!profile) return "No Harness Profile applied";
  const named = `${profile.name} v${profile.version}`;
  if (profile.applied === "selected") return `${named}, the profile this block selects`;
  if (profile.applied === "builtin") return `${named}, the built-in profile a run uses when a block selects none`;
  // A case a newer worker knows: shown as itself rather than guessed at.
  return `${named} (${profile.applied})`;
}

export interface ContextLine {
  /** True where the profile sends this, false where a run sends it at all. */
  sends: boolean;
  text: string;
}

/**
 * What the applied profile's switches mean for the prompt above.
 *
 * "Not coming" and "not shown here" are different sentences, and until the
 * worker reported these the screen could only say the second one. Both switches
 * always get a line: silence about a switch that is ON reads as an absence.
 */
export function contextLines(context: PreviewContext): ContextLine[] {
  return [
    context.includeWorkflowData
      ? {
          sends: true,
          text: "This profile receives workflow data, so a run carries the values below. The ones shown are examples built from each binding's schema, not what a run would carry.",
        }
      : {
          sends: false,
          text: "This profile receives no workflow data. A run sends no values from the workflow at all, which is why there are none above.",
        },
    context.includeRepositoryInstructions
      ? {
          // Where they come from and why they are not here belongs to the
          // "only a run composes these" entry, which is shown in exactly this
          // case. Saying it twice would be noise.
          sends: true,
          text: "This profile receives the repository instructions.",
        }
      : {
          sends: false,
          text: "This profile receives no repository instructions. AGENTS.md, CLAUDE.md and repository rules are not coming, here or on a run.",
        },
  ];
}

const GAP_TITLES: Record<string, string> = {
  repository_instructions: "Repository instructions",
  repository_memory: "Repo memory",
  repository_map: "Repository map",
  ticket_and_pull_request: "Ticket and pull request",
  run_notes: "The run's own notes",
  platform_rules: "Our own rules",
};

/** A section only a run can compose, by name. A kind this build has no name
 *  for is shown as the worker spelled it. */
export function gapTitle(kind: string): string {
  return Object.hasOwn(GAP_TITLES, kind) ? GAP_TITLES[kind]! : kind;
}
