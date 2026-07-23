"use client";

import { useEffect, useMemo } from "react";

import type { FlowNodeDef } from "@/lib/flows";
import type {
  HarnessProfileManifestV1,
  HarnessProfileReference,
  JsonValue,
  WorkflowEditorOptions,
  WorkflowValueSchema,
} from "@shared/contracts";
import { isHarnessProfileReference } from "@shared/contracts";
import { Listbox } from "@/components/cockpit/listbox";
import { previewHarnessCapabilities } from "@/lib/harness-profiles/capabilities";
import { usePromptAuthoringContext } from "./prompt-authoring-context";
import { useHarnessProfileCatalog } from "./harness-profile-context";

function ProfileField({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-neutral-200 px-[14px] py-2.5">
      <div className="flex items-center gap-2">
        <label className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
          {label}
        </label>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

function outputSummary(schema: WorkflowValueSchema): string {
  if (schema.type !== "object") return schema.type;
  const fields = Object.keys(schema.properties);
  return fields.length > 0 ? fields.join(", ") : "No named fields";
}

function limitLabel(
  label: string,
  value: number | null,
  suffix = "",
): string {
  return `${label}: ${value === null ? "inherited" : `${value}${suffix}`}`;
}

function CapabilityList({
  title,
  values,
  empty,
  tone = "neutral",
}: {
  title: string;
  values: string[];
  empty: string;
  tone?: "neutral" | "effective" | "clipped";
}) {
  const toneClass =
    tone === "effective"
      ? "border-green-200 bg-green-50 text-green-800"
      : tone === "clipped"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-neutral-200 bg-app-bg text-neutral-700";
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-600">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {values.length === 0 ? (
          <span className="font-body text-[10px] text-neutral-500">{empty}</span>
        ) : (
          values.map((value) => (
            <span
              key={value}
              className={`rounded-[3px] border px-1.5 py-0.5 font-mono text-[9px] ${toneClass}`}
            >
              {value}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function ManifestDetails({
  node,
  manifest,
  manifestHash,
}: {
  node: FlowNodeDef;
  manifest: HarnessProfileManifestV1;
  manifestHash: string;
}) {
  const capabilities = previewHarnessCapabilities({
    nodeType: node.type,
    workspaceMode: node.v2?.configuration.workspaceMode,
    manifest,
  });
  const declared = [
    ...capabilities.requestedTools.map((value) => `tool:${value}`),
    ...capabilities.requestedMcpIntegrations.map((value) => `mcp:${value}`),
    ...(capabilities.subagents.requested ? ["subagents"] : []),
  ];
  const effective = [
    ...capabilities.tools.map((value) => `tool:${value}`),
    ...capabilities.mcpIntegrations.map((value) => `mcp:${value}`),
    ...(capabilities.subagents.enabled
      ? ["subagents"]
      : []),
  ];
  const clipped = [
    ...capabilities.clippedTools.map((value) => `tool:${value}`),
    ...capabilities.clippedMcpIntegrations.map((value) => `mcp:${value}`),
    ...(capabilities.subagents.clipped ? ["subagents"] : []),
  ];

  return (
    <div className="border-b border-neutral-200 px-[14px] py-2.5">
      <div className="rounded-[3px] border border-neutral-200 bg-panel p-2.5">
        <div className="grid gap-1 font-body text-[10px] text-neutral-700">
          <div>
            <span className="font-semibold text-coal">
              {manifest.harness.provider === "codex" ? "Codex" : "Claude"}{" "}
              {manifest.model.id}
            </span>
            {" · "}
            {manifest.harness.packageName}@{manifest.harness.cliVersion}
          </div>
          <div className="font-mono text-[9px] text-neutral-500">
            Manifest {manifestHash}
          </div>
          <div>
            Context:{" "}
            {manifest.context.includeRepositoryInstructions
              ? "repository instructions (required)"
              : "repository instructions omitted (unsupported)"}
            {manifest.context.includeWorkflowData ? ", workflow data" : ""}
            {" · "}compaction: provider default (fixed)
          </div>
          <div>
            Model options: provider default (fixed)
          </div>
          <div>
            {limitLabel("duration", manifest.limits.maxDurationMs, " ms")}
            {" · "}
            {limitLabel("tokens", manifest.limits.maxTokens)}
            {" · "}
            {limitLabel("cost", manifest.limits.maxCostUsd, " USD")}
          </div>
          <div>
            Workspace: {manifest.workspace.mode}
            {manifest.workspace.preserveAcrossBlocks
              ? ", reused across compatible blocks"
              : ", fresh per invocation"}
            {" · "}home files: {manifest.homeFiles.length}
          </div>
          <div>
            Subagents:{" "}
            {capabilities.subagents.requested
              ? `requested (${manifest.subagents.maxConcurrent} max), ${
                  capabilities.subagents.enabled
                    ? "effective"
                    : "unavailable in the current runtime"
                }`
              : "disabled"}
          </div>
        </div>
        <div className="mt-2 grid gap-2">
          <CapabilityList
            title="Pinned skills"
            values={manifest.skills.map((skill) => skill.name)}
            empty="No skills"
          />
          <CapabilityList
            title="Declared capabilities"
            values={declared}
            empty="None declared"
          />
          <CapabilityList
            title="Effective for this block"
            values={effective}
            empty="No effective capabilities"
            tone="effective"
          />
          {clipped.length > 0 && (
            <CapabilityList
              title="Unavailable after runtime and block safety checks"
              values={clipped}
              empty=""
              tone="clipped"
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentHarnessProfile({
  node,
  options,
  canEdit,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
}) {
  const promptAuthoring = usePromptAuthoringContext();
  const catalog = useHarnessProfileCatalog();
  const configured = node.v2?.configuration.harnessProfile;
  const reference: HarnessProfileReference | null =
    isHarnessProfileReference(configured) ? configured : null;
  const referenceProfileId = reference?.profileId;
  const selectedDetail = reference
    ? catalog.details.get(reference.profileId)
    : undefined;
  const selectedProfile =
    catalog.profiles.find((profile) => profile.id === reference?.profileId) ??
    selectedDetail?.profile ??
    null;
  const selectedVersion =
    reference && selectedDetail
      ? selectedDetail.versions.find(
          (version) => version.version === reference.version,
        ) ?? null
      : null;

  useEffect(() => {
    if (referenceProfileId) {
      catalog.loadDetail(referenceProfileId, reference?.version);
    }
  }, [catalog.loadDetail, reference?.version, referenceProfileId]);

  const selectableProfiles = useMemo(() => {
    const candidates =
      selectedProfile &&
      !catalog.profiles.some((profile) => profile.id === selectedProfile.id)
        ? [...catalog.profiles, selectedProfile]
        : catalog.profiles;
    return candidates.filter(
      (profile) =>
        profile.publishedVersion !== null &&
        (profile.archivedAt === null || profile.id === reference?.profileId),
    );
  }, [catalog.profiles, reference, selectedProfile]);

  const contract = options.blockRegistry[node.type];
  const profileOptions = [
    ...(reference === null
      ? [{ value: "", label: "Select a published profile" }]
      : []),
    ...selectableProfiles.map((profile) => ({
      value: profile.id,
      label: `${profile.draft.displayName} · v${profile.publishedVersion}${
        profile.archivedAt ? " · archived (pinned)" : ""
      }`,
    })),
    ...(reference &&
    !selectableProfiles.some((profile) => profile.id === reference.profileId)
      ? [
          {
            value: reference.profileId,
            label: `Unavailable profile (${reference.profileId}) · v${reference.version}`,
          },
        ]
      : []),
  ];
  const versionOptions =
    selectedDetail?.versions.map((version) => ({
      value: String(version.version),
      label: `Version ${version.version} · ${version.manifestHash.slice(0, 12)}`,
    })) ?? [];
  const updateAvailable =
    reference &&
    selectedProfile?.publishedVersion !== null &&
    selectedProfile?.publishedVersion !== undefined &&
    selectedProfile.publishedVersion !== reference.version &&
    selectedProfile.archivedAt === null;

  function setReference(next: HarnessProfileReference) {
    if (!promptAuthoring || !node.v2) return;
    const configuration: Record<string, JsonValue> = {
      ...node.v2.configuration,
      harnessProfile: {
        profileId: next.profileId,
        version: next.version,
      },
    };
    delete configuration.provider;
    delete configuration.model;
    promptAuthoring.onV2ConfigurationChange(configuration);
  }

  return (
    <>
      <div className="border-b border-neutral-200 bg-app-bg px-[14px] py-2.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-600">
          Fixed semantic contract
        </div>
        <div className="mt-1 font-body text-[11px] font-semibold text-coal">
          {contract?.presentation.label ?? node.type}
        </div>
        <div className="mt-0.5 font-body text-[10px] leading-[1.4] text-neutral-600">
          {contract?.presentation.description ??
            "This block keeps its code-owned purpose and output contract."}
        </div>
        {contract && (
          <div className="mt-1 font-mono text-[9px] text-neutral-500">
            Output: {outputSummary(contract.output.bindingSchema)}
          </div>
        )}
      </div>

      <ProfileField label="Harness profile">
        <Listbox
          options={profileOptions}
          value={reference?.profileId ?? ""}
          disabled={
            !canEdit ||
            promptAuthoring === null ||
            catalog.status !== "ready" ||
            profileOptions.length === 0
          }
          ariaLabel="Harness profile"
          onChange={(profileId) => {
            const profile = catalog.profiles.find(
              (candidate) => candidate.id === profileId,
            );
            if (
              !profile ||
              profile.archivedAt !== null ||
              profile.publishedVersion === null
            ) {
              return;
            }
            setReference({
              profileId: profile.id,
              version: profile.publishedVersion,
            });
            catalog.loadDetail(profile.id);
          }}
        />
        {catalog.status === "loading" && (
          <span className="font-body text-[10px] text-neutral-500">
            Loading organization profiles…
          </span>
        )}
        {catalog.status === "error" && (
          <span className="font-body text-[10px] text-red-600">
            The profile catalog is unavailable. Existing pins are preserved.
          </span>
        )}
        {reference === null && catalog.status === "ready" && (
          <span className="font-body text-[10px] text-red-600">
            Select an exact published profile before saving this v2 block.
          </span>
        )}
      </ProfileField>

      {reference && (
        <ProfileField
          label="Pinned version"
          action={
            updateAvailable ? (
              <button
                type="button"
                onClick={() =>
                  setReference({
                    profileId: reference.profileId,
                    version: selectedProfile!.publishedVersion!,
                  })
                }
                disabled={!canEdit || promptAuthoring === null}
                className="appearance-none border-none bg-transparent p-0 font-body text-[10px] text-mariner cursor-pointer disabled:opacity-40"
              >
                Update to v{selectedProfile?.publishedVersion}
              </button>
            ) : undefined
          }
        >
          <Listbox
            options={versionOptions}
            value={String(reference.version)}
            disabled={
              !canEdit ||
              promptAuthoring === null ||
              selectedProfile?.archivedAt !== null ||
              versionOptions.length === 0
            }
            ariaLabel="Harness profile version"
            onChange={(version) => {
              const parsed = Number(version);
              if (
                !Number.isInteger(parsed) ||
                parsed <= 0 ||
                selectedProfile?.archivedAt
              ) {
                return;
              }
              setReference({ profileId: reference.profileId, version: parsed });
            }}
          />
          {!selectedDetail && !catalog.detailErrors.has(reference.profileId) && (
            <span className="font-body text-[10px] text-neutral-500">
              Loading immutable versions…
            </span>
          )}
          {catalog.detailErrors.has(reference.profileId) && (
            <span className="font-body text-[10px] text-red-600">
              Unable to verify the pinned profile version. The stored reference
              has not been changed.
            </span>
          )}
          {selectedDetail && selectedVersion === null && (
            <span className="font-body text-[10px] text-red-600">
              Pinned version {reference.version} does not exist for this
              profile.
            </span>
          )}
        </ProfileField>
      )}

      {selectedVersion && (
        <ManifestDetails
          node={node}
          manifest={selectedVersion.manifest}
          manifestHash={selectedVersion.manifestHash}
        />
      )}
    </>
  );
}
