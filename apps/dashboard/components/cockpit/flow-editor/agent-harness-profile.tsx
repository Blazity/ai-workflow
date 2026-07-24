"use client";

import { useEffect, useMemo, useState } from "react";

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
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-neutral-200 px-[14px] py-2.5">
      <label className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
        {label}
      </label>
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
    <div className="rounded-[3px] border border-neutral-200 bg-panel p-3">
      <div className="grid gap-1 font-body text-[11px] text-neutral-700">
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
        <div>Model options: provider default (fixed)</div>
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
      <div className="mt-3 grid gap-3">
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
  );
}

function profileVersionValue(profileId: string, version: number): string {
  return JSON.stringify([profileId, version]);
}

function parseProfileVersionValue(
  value: string,
): HarnessProfileReference | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      !Number.isInteger(parsed[1]) ||
      Number(parsed[1]) <= 0
    ) {
      return null;
    }
    return { profileId: parsed[0], version: Number(parsed[1]) };
  } catch {
    return null;
  }
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
  const [detailsOpen, setDetailsOpen] = useState(false);
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

  useEffect(() => {
    if (catalog.status !== "ready") return;
    for (const profile of selectableProfiles) {
      catalog.loadDetail(profile.id, profile.publishedVersion ?? undefined);
    }
  }, [catalog.loadDetail, catalog.status, selectableProfiles]);

  useEffect(() => {
    setDetailsOpen(false);
  }, [reference?.profileId, reference?.version]);

  useEffect(() => {
    if (!detailsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailsOpen]);

  const contract = options.blockRegistry[node.type];
  const profileVersionOptions = useMemo(() => {
    const options = selectableProfiles.flatMap((profile) => {
      const detail = catalog.details.get(profile.id);
      const versions =
        detail?.versions ??
        (profile.publishedVersion === null
          ? []
          : [{ version: profile.publishedVersion, manifest: profile.draft }]);
      return versions.map((version) => ({
        value: profileVersionValue(profile.id, version.version),
        label: `${profile.draft.displayName} · v${version.version} · ${
          version.manifest.model.id
        }${profile.archivedAt ? " · archived (pinned)" : ""}`,
      }));
    });
    if (
      reference &&
      !options.some(
        (option) =>
          option.value ===
          profileVersionValue(reference.profileId, reference.version),
      )
    ) {
      options.push({
        value: profileVersionValue(reference.profileId, reference.version),
        label: `Unavailable profile (${reference.profileId}) · v${reference.version}`,
      });
    }
    return [
      ...(reference === null
        ? [{ value: "", label: "Select a published profile and version" }]
        : []),
      ...options,
    ];
  }, [catalog.details, reference, selectableProfiles]);
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

      <ProfileField label="Harness profile & version">
        <Listbox
          options={profileVersionOptions}
          value={
            reference
              ? profileVersionValue(reference.profileId, reference.version)
              : ""
          }
          disabled={
            !canEdit ||
            promptAuthoring === null ||
            catalog.status !== "ready" ||
            profileVersionOptions.length === 0
          }
          ariaLabel="Harness profile and exact version"
          onChange={(value) => {
            const next = parseProfileVersionValue(value);
            if (!next) return;
            const profile = catalog.profiles.find(
              (candidate) => candidate.id === next.profileId,
            );
            if (
              !profile ||
              (profile.archivedAt !== null &&
                profile.id !== reference?.profileId)
            ) {
              return;
            }
            setReference(next);
            catalog.loadDetail(profile.id, next.version);
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

      {reference && selectedProfile && (
        <div className="border-b border-neutral-200 px-[14px] py-2.5">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`View ${selectedProfile.draft.displayName} version ${reference.version} details`}
            onClick={() => setDetailsOpen(true)}
            disabled={!selectedVersion}
            className="group w-full cursor-pointer rounded-[3px] border border-neutral-200 bg-off-white p-2.5 text-left outline-none transition-[border-color,background-color,box-shadow] hover:border-mariner-200 hover:bg-mariner-100 focus-visible:border-mariner focus-visible:ring-2 focus-visible:ring-mariner-200 disabled:cursor-default disabled:opacity-60"
          >
            <span className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11px] font-semibold text-coal">
                  {selectedProfile.draft.displayName}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[9px] uppercase text-neutral-500">
                  v{reference.version} ·{" "}
                  {selectedVersion?.manifest.harness.provider ??
                    selectedProfile.draft.harness.provider}{" "}
                  ·{" "}
                  {selectedVersion?.manifest.model.id ??
                    selectedProfile.draft.model.id}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase text-mariner">
                View details →
              </span>
            </span>
            <span className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-[3px] border border-neutral-200 bg-app-bg px-1.5 py-0.5 font-mono text-[9px] text-neutral-600">
                {selectedVersion?.manifest.skills.length ?? 0} skills
              </span>
              <span className="rounded-[3px] border border-neutral-200 bg-app-bg px-1.5 py-0.5 font-mono text-[9px] text-neutral-600">
                {selectedVersion?.manifest.tools.length ?? 0} tools
              </span>
              {updateAvailable && (
                <span className="rounded-[3px] border border-mariner-200 bg-mariner-100 px-1.5 py-0.5 font-mono text-[9px] text-mariner">
                  v{selectedProfile.publishedVersion} available
                </span>
              )}
              {selectedProfile.archivedAt && (
                <span className="rounded-[3px] border border-neutral-300 bg-app-bg px-1.5 py-0.5 font-mono text-[9px] text-neutral-600">
                  archived pin
                </span>
              )}
            </span>
          </button>
          {!selectedDetail && !catalog.detailErrors.has(reference.profileId) && (
            <span className="mt-1 block font-body text-[10px] text-neutral-500">
              Loading immutable versions…
            </span>
          )}
          {catalog.detailErrors.has(reference.profileId) && (
            <span className="mt-1 block font-body text-[10px] text-red-600">
              Unable to verify the pinned profile version. The stored reference
              has not been changed.
            </span>
          )}
          {selectedDetail && selectedVersion === null && (
            <span className="mt-1 block font-body text-[10px] text-red-600">
              Pinned version {reference.version} does not exist for this
              profile.
            </span>
          )}
        </div>
      )}

      {detailsOpen && reference && selectedVersion && selectedProfile && (
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center bg-coal/40 p-4 backdrop-blur-[1px]"
          onPointerDown={() => setDetailsOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="harness-profile-details-title"
            onPointerDown={(event) => event.stopPropagation()}
            className="flex max-h-[86vh] w-full max-w-[680px] flex-col overflow-hidden rounded-[5px] border border-neutral-200 bg-panel shadow-[0_18px_50px_-12px_rgba(24,27,32,0.4)]"
          >
            <header className="flex items-start gap-3 border-b border-neutral-200 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2
                  id="harness-profile-details-title"
                  className="m-0 font-display text-[18px] font-semibold text-coal"
                >
                  {selectedProfile.draft.displayName} · v{reference.version}
                </h2>
                <p className="mt-0.5 mb-0 font-body text-[11px] text-neutral-600">
                  Exact immutable environment used by this block.
                </p>
              </div>
              <button
                type="button"
                autoFocus
                onClick={() => setDetailsOpen(false)}
                aria-label="Close harness profile details"
                className="appearance-none border-none bg-transparent p-1 font-mono text-[16px] text-neutral-500 cursor-pointer hover:text-coal"
              >
                ×
              </button>
            </header>
            <div className="overflow-auto p-4">
              <ManifestDetails
                node={node}
                manifest={selectedVersion.manifest}
                manifestHash={selectedVersion.manifestHash}
              />
            </div>
          </section>
        </div>
      )}
    </>
  );
}
