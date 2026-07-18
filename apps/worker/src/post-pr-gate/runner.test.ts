import { describe, expect, it, vi } from "vitest";
import { executePostPrGatePhase } from "./runner.js";
import type { PostPrGateConfig, PostPrGateStepContext } from "./types.js";
import type {
  GateStatusCapableVCS,
  GateStatusRef,
  RichGateStatusCapableVCS,
  VCSAdapter,
} from "../adapters/vcs/types.js";

const gateStatusRef: GateStatusRef = { provider: "gitlab", name: "gate", headSha: "sha1" };

const config: PostPrGateConfig = {
  postPrGate: {
    runOn: { botPrsOnly: true, draftPrs: false, baseBranches: [] },
    steps: [{ uses: "code-hygiene", onFailure: "continue" }],
  },
};

const baseContext = {
  pr: {
    number: 42,
    url: "https://example.com/pr/42",
    headSha: "sha1",
    headRef: "blazebot/AIW-32",
    baseRef: "main",
    title: "AIW-32",
    body: "",
    author: "alice",
    isDraft: false,
  },
  ticket: null,
  diff: null,
  files: null,
  adapters: {
    issueTracker: {} as PostPrGateStepContext["adapters"]["issueTracker"],
    vcs: {} as PostPrGateStepContext["adapters"]["vcs"],
  },
} satisfies PostPrGateStepContext;

function vcsAdapter(methods: Partial<GateStatusCapableVCS & RichGateStatusCapableVCS>) {
  return {
    createBranch: vi.fn(),
    createPR: vi.fn(),
    push: vi.fn(),
    getPRComments: vi.fn(),
    postPRComment: vi.fn(),
    getCheckRunResults: vi.fn(),
    getPRConflictStatus: vi.fn(),
    getPRHeadSha: vi.fn(),
    findPR: vi.fn(),
    getBranchSha: vi.fn(),
    getPRHead: vi.fn(),
    ...methods,
  } as VCSAdapter & GateStatusCapableVCS & Partial<RichGateStatusCapableVCS>;
}

describe("executePostPrGatePhase gate status capabilities", () => {
  it("sends only common status fields to basic gate status providers", async () => {
    const updateGateStatus = vi.fn().mockResolvedValue(undefined);
    const vcs = vcsAdapter({
      createGateStatus: vi.fn(),
      updateGateStatus,
    });

    await executePostPrGatePhase({
      context: { ...baseContext, adapters: { ...baseContext.adapters, vcs } },
      config,
      gateStatusRefs: [gateStatusRef],
      registry: {
        "code-hygiene": vi.fn().mockResolvedValue({
          conclusion: "failure",
          summary: "Found issues",
          details: "Details that only rich providers can render.",
          annotations: [
            {
              path: "src/index.ts",
              startLine: 1,
              endLine: 1,
              annotationLevel: "warning",
              message: "debug log",
            },
          ],
        }),
      },
    });

    expect(updateGateStatus).toHaveBeenCalledWith(gateStatusRef, {
      status: "completed",
      conclusion: "failure",
      summary: "Found issues",
    });
  });

  it("sends details and annotations only through the rich gate status capability", async () => {
    const updateGateStatus = vi.fn().mockResolvedValue(undefined);
    const updateGateStatusDetails = vi.fn().mockResolvedValue(undefined);
    const vcs = vcsAdapter({
      createGateStatus: vi.fn(),
      updateGateStatus,
      updateGateStatusDetails,
    });

    await executePostPrGatePhase({
      context: { ...baseContext, adapters: { ...baseContext.adapters, vcs } },
      config,
      gateStatusRefs: [gateStatusRef],
      registry: {
        "code-hygiene": vi.fn().mockResolvedValue({
          conclusion: "failure",
          summary: "Found issues",
          details: "Details rendered by rich providers.",
          annotations: [
            {
              path: "src/index.ts",
              startLine: 1,
              endLine: 1,
              annotationLevel: "warning",
              message: "debug log",
            },
          ],
        }),
      },
    });

    expect(updateGateStatus).not.toHaveBeenCalled();
    expect(updateGateStatusDetails).toHaveBeenCalledWith(gateStatusRef, {
      status: "completed",
      conclusion: "failure",
      summary: "Found issues",
      details: "Details rendered by rich providers.",
      annotations: [
        {
          path: "src/index.ts",
          startLine: 1,
          endLine: 1,
          annotationLevel: "warning",
          message: "debug log",
        },
      ],
    });
  });
});
