import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_PROMPTS,
  type EffectivePromptCompilation,
  type EffectivePromptPart,
} from "@shared/prompts";
import {
  compileEffectivePrompt,
  resolveProfileInstructions,
} from "../../engine/helpers/effective-prompt.js";
import {
  fixContextParts,
  implementationContextParts,
  researchPlanContextParts,
  reviewContextParts,
  type ResearchPassNotes,
} from "../../sandbox/context.js";
import { composeRepositoryDiscoveryPrompt } from "../../engine/repository-discovery/runner.js";
import { genericAgentRuntimeData } from "../../engine/blocks/generic-agent/execute.js";
import {
  GOLDEN_DISCOVERY,
  GOLDEN_DISCOVERY_LEFT_OUT,
  GOLDEN_DISCOVERY_TICKET,
  GOLDEN_FIX_INPUT,
  GOLDEN_FLAT_FEEDBACK_CONTEXTS,
  GOLDEN_GENERIC,
  GOLDEN_LEDGER_CONTEXTS,
  GOLDEN_MANIFEST,
  GOLDEN_PLAN,
  GOLDEN_PRE_SANDBOX_ADDITIONS,
  GOLDEN_REPOSITORIES,
  GOLDEN_REPOSITORY_MAP,
  GOLDEN_REPOSITORY_SOURCES,
  GOLDEN_RESEARCH_LOOP,
  GOLDEN_REVIEW_CHANGE_SET,
  GOLDEN_TICKET,
} from "./golden-inputs";

/**
 * The prompt a model receives for each send kind, compiled the way the engine
 * compiles it (engine/agent-workflow.ts compileInvocationPrompt), stored under
 * __golden__ so a reviewer can read it. Captured at the base commit and
 * regenerated only with UPDATE_PROMPT_GOLDENS=1; a diff of these files is the
 * whole of what a change did to what agents read.
 *
 * Beside each prompt, <name>.parts.txt lists what it is made of, section by
 * section and part by part, the way a person debugging a run reads it.
 */
const GOLDEN_DIRECTORY = fileURLToPath(new URL("./__golden__/", import.meta.url));
const UPDATE = process.env.UPDATE_PROMPT_GOLDENS === "1";

async function profileSource(provider: "claude" | "codex") {
  const source = await resolveProfileInstructions({
    node: {
      id: "golden",
      type: "planning_agent",
      x: 0,
      y: 0,
      configuration: { provider },
      inputs: {},
      additionalInputs: [],
    } as never,
  });
  if (!source) throw new Error("the built-in profile did not resolve");
  return source;
}

interface Golden {
  prompt: string;
  sections: Array<{ title: string; parts: EffectivePromptPart[] }>;
  /** The profile switches the compilation applied, or null. */
  profileContext: EffectivePromptCompilation["profileContext"];
}

async function compile(input: {
  nodeId: string;
  blockPrompt: string;
  runtimeData: EffectivePromptPart[];
  includeWorkflowData?: boolean;
  withRepositorySources?: boolean;
  entryOutput?: Record<string, unknown>;
}): Promise<Golden> {
  const compilation: EffectivePromptCompilation = await compileEffectivePrompt({
    nodeId: input.nodeId,
    blockPrompt: input.blockPrompt,
    runtimeData: input.runtimeData,
    profileContext: {
      includeWorkflowData: input.includeWorkflowData !== false,
      includeRepositoryInstructions: true,
    },
    slots: [],
    promptManifest: [],
    profileSource: await profileSource("claude"),
    repositorySources: input.withRepositorySources === false ? [] : GOLDEN_REPOSITORY_SOURCES,
    memorySources: [],
    bindingContext: {
      entryOutput: (input.entryOutput ?? { status: "fired" }) as never,
      getStepOutput: () => undefined,
    },
  });
  expect(compilation.issues).toEqual([]);
  return {
    prompt: compilation.prompt,
    sections: compilation.sections.map((section) => ({
      title: `${section.kind}: ${section.title}`,
      parts: section.parts,
    })),
    profileContext: compilation.profileContext,
  };
}

/** One line per part: id, origin, size, and whether it was withheld or cut;
 *  then what the profile left out. */
function tableOfContents(golden: Golden): string {
  const leftOut = golden.profileContext
    ? Object.entries(golden.profileContext)
        .filter(([, included]) => !included)
        .map(([name]) => name)
    : [];
  return golden.sections
    .map((section) =>
      [
        `[${section.title}]`,
        ...section.parts.map((entry) => {
          const origin = [
            entry.origin.kind,
            entry.origin.ref ? `ref=${entry.origin.ref}` : "",
            entry.origin.label ? `label=${entry.origin.label}` : "",
          ].filter(Boolean).join(" ");
          const state = entry.withheld
            ? ` WITHHELD (${entry.withheld.reason})`
            : entry.cutBeforeSend
              ? ` CUT ${entry.cutBeforeSend} of ${entry.originalLengthUtf16} (${entry.cutCause})`
              : "";
          return `  ${entry.id.padEnd(28)} ${String(entry.content.length).padStart(6)}  ${origin}  "${entry.title}"${state}`;
        }),
      ].join("\n"),
    )
    .join("\n\n") +
    "\n" +
    (leftOut.length > 0 ? `\n[profile left out: ${leftOut.join(", ")}]\n` : "");
}

const researchContext = {
  ticket: GOLDEN_TICKET,
  branchName: "ai-workflow/aiw-512",
  selectedRepositories: [GOLDEN_REPOSITORIES.api, GOLDEN_REPOSITORIES.web],
  workspaceManifest: GOLDEN_MANIFEST,
  // The one send that can attach a repository, and only while the expansion is
  // open, so the golden shows the wording that offers it. Every other send
  // below keeps the default and shows the wording that does not.
  repositoryMap: { ...GOLDEN_REPOSITORY_MAP, expansionOpen: true },
};

const noLoopNotes: ResearchPassNotes = {
  priorRequests: [],
  refusals: [],
  expansionClosed: false,
  ledgerCorrectionNote: null,
  noChangeRetry: false,
};

function research(input: {
  additions: typeof GOLDEN_PRE_SANDBOX_ADDITIONS;
  loop: ResearchPassNotes;
  repositoryContexts?: typeof GOLDEN_LEDGER_CONTEXTS;
}): EffectivePromptPart[] {
  return researchPlanContextParts({
    ...researchContext,
    prompt: "",
    attachments: [
      { filename: "har.json", originalFilename: "har.json", mimeType: "application/json", size: 48_230 },
    ],
    preSandboxAdditions: input.additions,
    researchNotes: input.loop,
    ...(input.repositoryContexts ? { repositoryContexts: input.repositoryContexts } : {}),
  });
}

const GOLDENS: Record<string, () => Promise<Golden>> = {
  "research-first-pass": () =>
    compile({
      nodeId: "planning",
      blockPrompt: DEFAULT_AGENT_PROMPTS["research-plan"],
      runtimeData: research({ additions: GOLDEN_PRE_SANDBOX_ADDITIONS, loop: noLoopNotes }),
    }),
  "research-refusals-history-closed": () =>
    compile({
      nodeId: "planning",
      blockPrompt: DEFAULT_AGENT_PROMPTS["research-plan"],
      runtimeData: research({
        additions: [...GOLDEN_PRE_SANDBOX_ADDITIONS, GOLDEN_DISCOVERY_LEFT_OUT],
        loop: {
          ...noLoopNotes,
          priorRequests: GOLDEN_RESEARCH_LOOP.priorRequests,
          refusals: GOLDEN_RESEARCH_LOOP.refusals,
          expansionClosed: true,
        },
      }),
    }),
  "research-ledger-correction": () =>
    compile({
      nodeId: "planning",
      blockPrompt: DEFAULT_AGENT_PROMPTS["research-plan"],
      runtimeData: research({
        additions: GOLDEN_PRE_SANDBOX_ADDITIONS,
        loop: { ...noLoopNotes, ledgerCorrectionNote: GOLDEN_RESEARCH_LOOP.ledgerCorrectionNote, noChangeRetry: true },
        repositoryContexts: GOLDEN_LEDGER_CONTEXTS,
      }),
    }),
  "research-no-change-retry": () =>
    compile({
      nodeId: "planning",
      blockPrompt: DEFAULT_AGENT_PROMPTS["research-plan"],
      runtimeData: research({
        additions: GOLDEN_PRE_SANDBOX_ADDITIONS,
        loop: { ...noLoopNotes, noChangeRetry: true },
        repositoryContexts: GOLDEN_FLAT_FEEDBACK_CONTEXTS,
      }),
    }),
  "research-workflow-data-off": () =>
    compile({
      nodeId: "planning",
      blockPrompt: DEFAULT_AGENT_PROMPTS["research-plan"],
      runtimeData: research({ additions: GOLDEN_PRE_SANDBOX_ADDITIONS, loop: noLoopNotes }),
      includeWorkflowData: false,
    }),
  implementation: () =>
    compile({
      nodeId: "implementation",
      blockPrompt: DEFAULT_AGENT_PROMPTS.implement,
      runtimeData: implementationContextParts({
        ticket: GOLDEN_TICKET,
        prompt: "",
        researchPlanMarkdown: GOLDEN_PLAN,
        preSandboxAdditions: [...GOLDEN_PRE_SANDBOX_ADDITIONS, GOLDEN_DISCOVERY_LEFT_OUT],
        selectedRepositories: [GOLDEN_REPOSITORIES.api, GOLDEN_REPOSITORIES.web],
        repositoryContexts: GOLDEN_FLAT_FEEDBACK_CONTEXTS,
        workspaceManifest: GOLDEN_MANIFEST,
        repositoryMap: GOLDEN_REPOSITORY_MAP,
      }),
    }),
  review: () =>
    compile({
      nodeId: "review",
      blockPrompt: DEFAULT_AGENT_PROMPTS.review,
      runtimeData: reviewContextParts({
        ticket: GOLDEN_TICKET,
        prompt: "",
        researchPlanMarkdown: GOLDEN_PLAN,
        reviewFeedback: { state: "changes_requested", author: "Piotr", body: "Read the previous key too." },
        preSandboxAdditions: [GOLDEN_REVIEW_CHANGE_SET],
        selectedRepositories: [GOLDEN_REPOSITORIES.api, GOLDEN_REPOSITORIES.sdk],
        workspaceManifest: GOLDEN_MANIFEST,
        repositoryMap: GOLDEN_REPOSITORY_MAP,
      }),
    }),
  "generic-agent": () =>
    compile({
      nodeId: "summarize",
      blockPrompt: GOLDEN_GENERIC.blockPrompt,
      runtimeData: genericAgentRuntimeData(
        GOLDEN_GENERIC.resolvedInputs,
        GOLDEN_GENERIC.clarificationAnswer,
        {
          repositoryMap: GOLDEN_REPOSITORY_MAP,
          repositories: [GOLDEN_REPOSITORIES.api, GOLDEN_REPOSITORIES.web],
          workspaceManifest: GOLDEN_MANIFEST,
        },
      ),
      withRepositorySources: false,
      entryOutput: GOLDEN_GENERIC.entryOutput,
    }),
  "fix-agent": () =>
    compile({
      nodeId: "fix",
      blockPrompt: "Address every review thread and make the failing unit check pass.",
      runtimeData: fixContextParts({
        ticket: GOLDEN_TICKET,
        ...GOLDEN_FIX_INPUT,
        repositoryMap: GOLDEN_REPOSITORY_MAP,
      }),
    }),
  discovery: async () => {
    // No sections: discovery's parts tile the prompt itself.
    const composed = composeRepositoryDiscoveryPrompt({
      ticket: GOLDEN_DISCOVERY_TICKET as never,
      discovery: GOLDEN_DISCOVERY as never,
    });
    return {
      prompt: composed.prompt,
      sections: [{ title: "discovery prompt", parts: composed.parts }],
      profileContext: null,
    };
  },
};

describe("prompt goldens: what a model receives, per send kind", () => {
  it.each(Object.keys(GOLDENS))("%s", async (name) => {
    const golden = await GOLDENS[name]!();
    const file = `${GOLDEN_DIRECTORY}${name}.txt`;
    const contents = `${GOLDEN_DIRECTORY}${name}.parts.txt`;
    if (UPDATE) {
      writeFileSync(file, golden.prompt);
      writeFileSync(contents, tableOfContents(golden));
    }
    expect(golden.prompt).toBe(readFileSync(file, "utf8"));
    expect(tableOfContents(golden)).toBe(readFileSync(contents, "utf8"));
  });
});
