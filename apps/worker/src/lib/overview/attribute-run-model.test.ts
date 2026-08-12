import { describe, it, expect } from "vitest";
import type { BlockRunState, HarnessRunManifestRecord } from "@shared/contracts";
import { attributeRunModel } from "./attribute-run-model.js";

/** Minimal fixture: attributeRunModel only reads `.nodeId` / `.manifest.model.id`. */
function harnessManifest(nodeId: string, modelId: string): HarnessRunManifestRecord {
  return {
    nodeId,
    manifest: { model: { id: modelId } },
  } as unknown as HarnessRunManifestRecord;
}

type Statuses = Record<string, Omit<BlockRunState, "output">>;

describe("attributeRunModel", () => {
  it("returns null when the run carries no evidence at all", () => {
    expect(
      attributeRunModel({ model: null, harnessManifests: null, blockStatuses: null }),
    ).toBeNull();
    expect(
      attributeRunModel({ model: null, harnessManifests: [], blockStatuses: {} }),
    ).toBeNull();
    expect(
      attributeRunModel({
        model: "   ",
        harnessManifests: undefined,
        blockStatuses: undefined,
      }),
    ).toBeNull();
  });

  it("uses the persisted model when it is the only evidence", () => {
    expect(
      attributeRunModel({
        model: "gpt-5.6-luna",
        harnessManifests: null,
        blockStatuses: null,
      }),
    ).toBe("gpt-5.6-luna");
  });

  it("attributes the block that failed in the run's first phase", () => {
    // The reported bug: `model` holds the org default activeModel was seeded
    // with, and the alphabetically last manifest belongs to a block that never
    // ran. Only planning-1 executed, so only its model is attributable.
    const manifests = [
      harnessManifest("implementation-1", "claude-opus-4-8"),
      harnessManifest("planning-1", "gpt-5.6-sol"),
      harnessManifest("review-1", "claude-haiku-4-5"),
    ];
    const blockStatuses: Statuses = {
      "planning-1": { status: "fail" },
      "implementation-1": { status: "pending" },
      "review-1": { status: "pending" },
    };
    expect(
      attributeRunModel({ model: "claude-opus-4-8", harnessManifests: manifests, blockStatuses }),
    ).toBe("gpt-5.6-sol");
  });

  it("prefers the block executing right now over blocks that already finished", () => {
    const manifests = [
      harnessManifest("planning-1", "gpt-5.6-sol"),
      harnessManifest("implementation-1", "gpt-5.6-luna"),
    ];
    const blockStatuses: Statuses = {
      "planning-1": { status: "ok" },
      "implementation-1": { status: "running" },
    };
    expect(
      attributeRunModel({ model: null, harnessManifests: manifests, blockStatuses }),
    ).toBe("gpt-5.6-luna");
  });

  it("uses a unanimous manifest set when no block status is recorded yet", () => {
    const manifests = [
      harnessManifest("planning-1", "gpt-5.6-sol"),
      harnessManifest("implementation-1", "gpt-5.6-sol"),
    ];
    expect(
      attributeRunModel({ model: null, harnessManifests: manifests, blockStatuses: null }),
    ).toBe("gpt-5.6-sol");
  });

  it("beats the persisted org default with a unanimous manifest set", () => {
    expect(
      attributeRunModel({
        model: "claude-opus-4-8",
        harnessManifests: [harnessManifest("planning-1", "gpt-5.6-sol")],
        blockStatuses: null,
      }),
    ).toBe("gpt-5.6-sol");
  });

  it("keeps the persisted terminal model when several blocks ran on different models", () => {
    // A completed run: every block ran, so block status cannot single one out.
    // The persisted column is then the run's own recorded headline model.
    const manifests = [
      harnessManifest("planning-1", "gpt-5.6-sol"),
      harnessManifest("implementation-1", "gpt-5.6-luna"),
    ];
    const blockStatuses: Statuses = {
      "planning-1": { status: "ok" },
      "implementation-1": { status: "ok" },
    };
    expect(
      attributeRunModel({ model: "gpt-5.6-luna", harnessManifests: manifests, blockStatuses }),
    ).toBe("gpt-5.6-luna");
  });

  it("returns null when the evidence disagrees and nothing was persisted", () => {
    const manifests = [
      harnessManifest("planning-1", "gpt-5.6-sol"),
      harnessManifest("implementation-1", "gpt-5.6-luna"),
    ];
    const blockStatuses: Statuses = {
      "planning-1": { status: "ok" },
      "implementation-1": { status: "fail" },
    };
    expect(
      attributeRunModel({ model: null, harnessManifests: manifests, blockStatuses }),
    ).toBeNull();
  });

  it("ignores block statuses that name no manifest", () => {
    // Non-agent blocks (prepare_workspace, open_pr) have statuses but no
    // manifest; they must not empty the attribution.
    const manifests = [harnessManifest("planning-1", "gpt-5.6-sol")];
    const blockStatuses: Statuses = {
      "prepare-1": { status: "ok" },
      "planning-1": { status: "pending" },
    };
    expect(
      attributeRunModel({ model: null, harnessManifests: manifests, blockStatuses }),
    ).toBe("gpt-5.6-sol");
  });
});
