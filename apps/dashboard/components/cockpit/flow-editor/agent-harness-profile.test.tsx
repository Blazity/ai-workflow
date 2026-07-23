import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentHarnessProfile } from "./agent-harness-profile";
import { HarnessProfileCatalogProvider } from "./harness-profile-context";
import { PromptAuthoringProvider } from "./prompt-authoring-context";
import type { FlowNodeDef } from "@/lib/flows";
import type {
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifestV1,
  HarnessProfileDto,
  HarnessProfileManifestV1,
  JsonValue,
  WorkflowEditorOptions,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/contracts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function draft(): HarnessProfileDraftManifestV1 {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...value
  } = structuredClone(
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS.codex
    ],
  );
  return value;
}

function profile(
  overrides: Partial<HarnessProfileDto> = {},
): HarnessProfileDto {
  return {
    id: "profile-review",
    organizationId: "org-1",
    slug: "review",
    system: false,
    readOnly: false,
    archivedAt: null,
    draftRevision: 4,
    draftRestoredFromVersion: null,
    publishedVersion: 2,
    draft: draft(),
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    createdById: "user-1",
    updatedById: "user-1",
    ...overrides,
  };
}

function manifest(
  version: number,
  overrides: Partial<HarnessProfileManifestV1> = {},
): HarnessProfileManifestV1 {
  return {
    ...draft(),
    profileId: "profile-review",
    version,
    slug: "review",
    system: false,
    ...overrides,
  };
}

function detail(
  profileValue = profile(),
): HarnessProfileDetailResponse {
  const v1 = {
    profileId: profileValue.id,
    version: 1,
    manifest: manifest(1, {
      subagents: { enabled: true, maxConcurrent: 2 },
    }),
    manifestHash: "1".repeat(64),
    createdAt: "2026-07-22T00:00:00.000Z",
    createdById: "user-1",
    restoredFromVersion: null,
  };
  const v2 = {
    ...v1,
    version: 2,
    manifest: manifest(2),
    manifestHash: "2".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
  };
  return {
    profile: profileValue,
    published: v2,
    versions: [v2, v1],
    canManageProfile: true,
  };
}

const options = {
  blockRegistry: {
    review_agent: {
      presentation: {
        label: "Review agent",
        description: "Reviews the current workspace diff before publication.",
      },
      output: {
        bindingSchema: {
          type: "object",
          properties: {
            findings: { type: "array", items: { type: "unknown" } },
            decision: { type: "string" },
          },
          required: ["findings", "decision"],
          additionalProperties: false,
        },
      },
    },
  },
} as unknown as WorkflowEditorOptions;

function node(
  harnessProfile?: { profileId: string; version: number },
): FlowNodeDef {
  const configuration: Record<string, JsonValue> = harnessProfile
    ? {
        harnessProfile: {
          profileId: harnessProfile.profileId,
          version: harnessProfile.version,
        },
      }
    : {};
  return {
    id: "review",
    type: "review_agent",
    name: "Review",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: {
      configuration,
      inputs: {},
      additionalInputs: [],
    },
  };
}

function render(
  nodeValue: FlowNodeDef,
  profileValue = profile(),
  includeInCatalog = true,
): string {
  const profileDetail = detail(profileValue);
  return renderToStaticMarkup(
    <HarnessProfileCatalogProvider
      initial={{
        status: "ready",
        profiles: includeInCatalog ? [profileValue] : [],
        details: new Map([[profileValue.id, profileDetail]]),
      }}
    >
      <PromptAuthoringProvider
        availableValues={[]}
        onV2ConfigurationChange={() => undefined}
      >
        <AgentHarnessProfile node={nodeValue} options={options} canEdit />
      </PromptAuthoringProvider>
    </HarnessProfileCatalogProvider>,
  );
}

test("an unpinned v2 agent exposes its fixed contract and requires a published profile", () => {
  const html = render(node());
  assert.match(html, /Fixed semantic contract/);
  assert.match(html, /Reviews the current workspace diff before publication/);
  assert.match(html, /Output: findings, decision/);
  assert.match(html, /Select an exact published profile before saving/);
});

test("an exact old version remains selected and advertises an explicit update", () => {
  const html = render(
    node({ profileId: "profile-review", version: 1 }),
  );
  assert.match(html, /Pinned version/);
  assert.match(html, /Update to v2/);
  assert.match(html, /111111111111/);
  assert.match(html, /Declared capabilities/);
  assert.match(html, /Effective for this block/);
  assert.match(html, /Unavailable after runtime and block safety checks/);
  assert.doesNotMatch(html, /Clipped by the block safety envelope/);
  assert.match(html, /Model options: provider default \(fixed\)/);
  assert.match(html, /compaction: provider default \(fixed\)/);
  assert.match(html, /unavailable in the current runtime/);
  assert.match(html, /subagents/);
});

test("an archived existing pin stays readable but is not offered as a new update", () => {
  const archived = profile({
    archivedAt: "2026-07-23T12:00:00.000Z",
  });
  const html = render(
    node({ profileId: archived.id, version: 1 }),
    archived,
    false,
  );
  assert.match(html, /archived \(pinned\)/);
  assert.doesNotMatch(html, /Update to v2/);
});
