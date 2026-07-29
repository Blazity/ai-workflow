"use client";

import { useEffect, useState } from "react";

import { CkCard, CkChip } from "@/components/ui";
import { Listbox } from "@/components/cockpit/listbox";
import { SkillImport } from "./skill-import";
import {
  canEditProfile,
  isProfileSlug,
  newProfileDraft,
  upgradeProfileDraft,
  withHarnessProvider,
} from "@/lib/harness-profiles/editor";
import { readErrorMessage } from "@/lib/api/error-message";
import type {
  HarnessCapabilitiesResponse,
  HarnessModelCapability,
  HarnessProvider,
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifest,
  HarnessProfileDraftManifestV1,
  HarnessProfileDto,
  HarnessProfileSkillReference,
  HarnessSkillArtifact,
} from "@shared/contracts";
import { HARNESS_TOOL_IDS, stableJson } from "@shared/contracts";

const inputClass =
  "h-[30px] w-full rounded-[3px] border border-neutral-200 bg-white px-2 font-mono text-[11px] text-coal outline-none focus:border-mariner disabled:bg-app-bg disabled:opacity-70";
const textareaClass =
  "min-h-[74px] w-full resize-y rounded-[3px] border border-neutral-200 bg-white px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-coal outline-none focus:border-mariner disabled:bg-app-bg disabled:opacity-70";
const secondaryButtonClass =
  "appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal cursor-pointer disabled:cursor-default disabled:opacity-40";
const primaryButtonClass =
  "appearance-none rounded-[3px] border border-mariner bg-mariner px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-white cursor-pointer disabled:cursor-default disabled:opacity-40";

type ProfileAction =
  | "save"
  | "publish"
  | "fork"
  | "archive"
  | "unarchive"
  | "remove"
  | `restore-${number}`
  | `refresh-${string}`;

export interface ProfileEditorProps {
  detail: HarnessProfileDetailResponse;
  canManageProfiles: boolean;
  busy: ProfileAction | null;
  error: string | null;
  onSave: (draft: HarnessProfileDraftManifest) => Promise<void>;
  onPublish: () => Promise<void>;
  onFork: (slug: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
  onDelete: () => Promise<void>;
  onRestore: (version: number) => Promise<void>;
  onRefreshSkill: (artifactHash: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  initialMode?: "overview" | "edit" | "review";
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
        {label}
      </span>
      {children}
      {hint && (
        <span className="font-body text-[10px] leading-[1.35] text-neutral-500">
          {hint}
        </span>
      )}
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 font-body text-[12px] text-neutral-800">
      <input
        aria-label={label}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-mariner"
      />
      {label}
    </label>
  );
}

export function parseHomeFiles(
  source: string,
  provider: HarnessProvider,
): HarnessProfileDraftManifestV1["homeFiles"] | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!Array.isArray(value) || value.length > 1) return null;
    const allowedPath = provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
    if (
      value.some(
        (file) =>
          !file ||
          typeof file !== "object" ||
          Object.keys(file).length !== 3 ||
          !["path", "content", "mode"].every((key) => key in file) ||
          (file as { path?: unknown }).path !== allowedPath ||
          typeof (file as { content?: unknown }).content !== "string" ||
          new TextEncoder().encode((file as { content: string }).content)
            .byteLength >
            1024 * 1024 ||
          (file as { mode?: unknown }).mode !== 0o644,
      )
    ) {
      return null;
    }
    const files = value as HarnessProfileDraftManifestV1["homeFiles"];
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      return null;
    }
    const totalBytes = files.reduce(
      (total, file) =>
        total + new TextEncoder().encode(file.content).byteLength,
      0,
    );
    return totalBytes <= 5 * 1024 * 1024 ? files : null;
  } catch {
    return null;
  }
}

function nullableNumber(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function mergeSkills(
  current: HarnessProfileSkillReference[],
  incoming: HarnessProfileSkillReference[],
): HarnessProfileSkillReference[] {
  const next = [...current];
  for (const skill of incoming) {
    const withoutPrevious = next.filter(
      (candidate) =>
        candidate.name !== skill.name &&
        candidate.artifactHash !== skill.artifactHash,
    );
    next.splice(0, next.length, ...withoutPrevious, skill);
  }
  return next;
}

export function ProfileEditor({
  detail,
  canManageProfiles,
  busy,
  error,
  onSave,
  onPublish,
  onFork,
  onArchive,
  onUnarchive,
  onDelete,
  onRestore,
  onRefreshSkill,
  onDirtyChange,
  initialMode = "overview",
}: ProfileEditorProps) {
  const profile = detail.profile;
  const [draft, setDraft] = useState<HarnessProfileDraftManifest>(() =>
    structuredClone(profile.draft),
  );
  const [homeFilesSource, setHomeFilesSource] = useState(() =>
    JSON.stringify(profile.draft.homeFiles, null, 2),
  );
  const [homeFilesError, setHomeFilesError] = useState(false);
  const [forkSlug, setForkSlug] = useState("");
  const [showFork, setShowFork] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [mode, setMode] = useState<"overview" | "edit" | "review">(
    initialMode,
  );
  const [showSkillImport, setShowSkillImport] = useState(false);
  const [inspectedVersion, setInspectedVersion] = useState<number | null>(null);
  const [editSection, setEditSection] = useState<
    | "general"
    | "context"
    | "instructions"
    | "skills"
    | "tools"
    | "limits"
    | "home-files"
  >("general");
  const [importedArtifacts, setImportedArtifacts] = useState<
    Map<string, HarnessSkillArtifact>
  >(new Map());
  const [capabilities, setCapabilities] =
    useState<HarnessCapabilitiesResponse | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  useEffect(() => {
    setDraft(structuredClone(profile.draft));
    setHomeFilesSource(JSON.stringify(profile.draft.homeFiles, null, 2));
    setHomeFilesError(false);
    setConfirmArchive(false);
    setConfirmDelete(false);
    setConfirmRestore(null);
    setMode("overview");
    setShowSkillImport(false);
    setInspectedVersion(null);
    setEditSection("general");
    setImportedArtifacts(new Map());
  }, [profile.id, profile.draftRevision, profile.draft]);

  useEffect(() => {
    const controller = new AbortController();
    setCapabilityLoading(true);
    setCapabilityError(null);
    const query = new URLSearchParams({
      provider: draft.harness.provider,
      cliVersion: draft.harness.cliVersion,
    });
    void fetch(`/api/harness-capabilities?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response));
        return response.json() as Promise<HarnessCapabilitiesResponse>;
      })
      .then((next) => {
        if (!controller.signal.aborted) setCapabilities(next);
      })
      .catch((nextError: unknown) => {
        if (
          !controller.signal.aborted &&
          !(nextError instanceof DOMException && nextError.name === "AbortError")
        ) {
          setCapabilities(null);
          setCapabilityError(
            nextError instanceof Error
              ? nextError.message
              : "Harness capabilities are unavailable.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCapabilityLoading(false);
      });
    return () => controller.abort();
  }, [draft.harness.cliVersion, draft.harness.provider]);

  useEffect(() => {
    if (
      mode !== "edit" ||
      draft.schemaVersion !== 1 ||
      !capabilities ||
      capabilities.stale ||
      capabilities.provider !== draft.harness.provider ||
      capabilities.cliVersion !== draft.harness.cliVersion
    ) {
      return;
    }
    const upgraded = upgradeProfileDraft(draft, capabilities);
    if (upgraded) setDraft(upgraded);
  }, [capabilities, draft, mode]);

  const editable = canEditProfile(profile, detail.canManageProfile);
  const hasCompleteRuntimeToolSet =
    draft.tools.length === HARNESS_TOOL_IDS.length &&
    HARNESS_TOOL_IDS.every((tool) => draft.tools.includes(tool));
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(profile.draft) ||
    homeFilesError;
  const valid =
    draft.displayName.trim() !== "" &&
    draft.displayName.trim().length <= 120 &&
    draft.description.trim().length <= 2_000 &&
    draft.harness.packageName.trim() !== "" &&
    draft.harness.cliVersion.trim() !== "" &&
    draft.harness.protocolVersion.trim() !== "" &&
    draft.model.id.trim() !== "" &&
    draft.model.id.trim().length <= 200 &&
    (draft.schemaVersion === 1
      ? Object.keys(draft.model.options).length === 0
      : capabilities !== null &&
        !capabilities.stale &&
        capabilities.catalogHash === draft.model.catalogHash &&
        capabilities.models.some(
          (model) =>
            model.id === draft.model.id &&
            stableJson(model) === stableJson(draft.model.capability),
        )) &&
    draft.context.includeRepositoryInstructions &&
    (draft.compaction.mode !== "custom_threshold" ||
      (draft.schemaVersion === 2 &&
        draft.model.capability.contextWindowTokens !== null &&
        draft.compaction.thresholdTokens ===
          Math.floor(
            (draft.model.capability.contextWindowTokens *
              draft.compaction.thresholdPercent) /
              100,
          ))) &&
    draft.workspace.mode === "managed" &&
    hasCompleteRuntimeToolSet &&
    draft.mcpIntegrations.length === 0 &&
    !homeFilesError &&
    draft.instructions.length <= 100_000 &&
    draft.skills.length <= 100 &&
    draft.subagents.maxConcurrent >= 0 &&
    draft.subagents.maxConcurrent <= 16 &&
    (draft.subagents.enabled
      ? draft.subagents.maxConcurrent >= 1
      : draft.subagents.maxConcurrent === 0) &&
    (draft.limits.maxDurationMs === null ||
      (draft.limits.maxDurationMs > 0 &&
        draft.limits.maxDurationMs <= 86_400_000)) &&
    (draft.limits.maxTokens === null ||
      (draft.limits.maxTokens > 0 &&
        draft.limits.maxTokens <= 10_000_000)) &&
    (draft.limits.maxCostUsd === null ||
      (draft.limits.maxCostUsd > 0 &&
        draft.limits.maxCostUsd <= 100_000));
  const published = detail.published;
  const usage = detail.usage ?? [];
  const catalogModels =
    capabilities?.provider === draft.harness.provider &&
    capabilities.cliVersion === draft.harness.cliVersion
      ? capabilities.models
      : [];
  const filteredModels = catalogModels.filter((model) => {
    const query = modelSearch.trim().toLowerCase();
    return (
      query === "" ||
      model.id.toLowerCase().includes(query) ||
      model.name.toLowerCase().includes(query) ||
      model.description?.toLowerCase().includes(query)
    );
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function update(next: Partial<HarnessProfileDraftManifest>) {
    setDraft(
      (current) =>
        ({ ...current, ...next }) as HarnessProfileDraftManifest,
    );
  }

  function selectModel(model: HarnessModelCapability) {
    if (!capabilities || capabilities.stale) return;
    const effort =
      model.defaultReasoningEffort ?? model.reasoningEfforts[0]?.id;
    const serviceTier =
      model.defaultServiceTier ?? model.serviceTiers[0]?.id;
    if (!effort || !serviceTier) return;
    setDraft((current) => ({
      ...current,
      schemaVersion: 2,
      model: {
        id: model.id,
        reasoning: {
          selection: "model_default",
          effectiveEffort: effort,
        },
        serviceTier,
        ...(model.defaultVerbosity
          ? { verbosity: model.defaultVerbosity }
          : {}),
        capability: structuredClone(model),
        catalogHash: capabilities.catalogHash,
      },
      compaction: { mode: "model_default" },
    }));
  }

  async function switchProvider(provider: HarnessProvider) {
    if (provider === draft.harness.provider) return;
    if (draft.schemaVersion === 1) {
      const next = withHarnessProvider(draft, provider);
      if (!next) return;
      setDraft(next);
      setHomeFilesSource(JSON.stringify(next.homeFiles, null, 2));
      setHomeFilesError(false);
      return;
    }

    const baseline = newProfileDraft(provider);
    const query = new URLSearchParams({
      provider,
      cliVersion: baseline.harness.cliVersion,
    });
    setCapabilityLoading(true);
    setCapabilityError(null);
    try {
      const response = await fetch(
        `/api/harness-capabilities?${query.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const targetCapabilities =
        (await response.json()) as HarnessCapabilitiesResponse;
      const next = withHarnessProvider(
        draft,
        provider,
        targetCapabilities,
      );
      if (!next) {
        throw new Error(
          "The target provider capabilities do not include its default model.",
        );
      }
      setCapabilities(targetCapabilities);
      setDraft(next);
      setHomeFilesSource(JSON.stringify(next.homeFiles, null, 2));
      setHomeFilesError(false);
    } catch (nextError) {
      setCapabilityError(
        nextError instanceof Error
          ? nextError.message
          : "Harness capabilities are unavailable.",
      );
    } finally {
      setCapabilityLoading(false);
    }
  }

  function discardLocalChanges() {
    setDraft(structuredClone(profile.draft));
    setHomeFilesSource(JSON.stringify(profile.draft.homeFiles, null, 2));
    setHomeFilesError(false);
    setImportedArtifacts(new Map());
    setMode("overview");
  }

  const draftChangedFromPublished =
    published === null ||
    JSON.stringify({
      ...published.manifest,
      profileId: undefined,
      version: undefined,
      slug: undefined,
      system: undefined,
    }) !==
      JSON.stringify({
        ...profile.draft,
        profileId: undefined,
        version: undefined,
        slug: undefined,
        system: undefined,
      });

  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="m-0 font-display text-[22px] font-semibold text-coal">
              {profile.draft.displayName}
            </h1>
            {profile.archivedAt && <CkChip tone="blocked">Archived</CkChip>}
            {profile.system && <CkChip tone="mariner">System</CkChip>}
            {!profile.archivedAt && profile.publishedVersion !== null && (
              <CkChip tone="success">
                Published v{profile.publishedVersion}
              </CkChip>
            )}
            {!profile.archivedAt && draftChangedFromPublished && (
              <CkChip tone="mariner">Draft changes</CkChip>
            )}
          </div>
          <div className="mt-1 font-mono text-[10px] text-neutral-500">
            {draft.harness.provider} · {draft.model.id} ·{" "}
            {draft.harness.packageName}@{draft.harness.cliVersion}
            {profile.draftRestoredFromVersion !== null &&
              ` · restored from v${profile.draftRestoredFromVersion}`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "overview" && canManageProfiles && (
            <button
              type="button"
              onClick={() => setShowFork((visible) => !visible)}
              disabled={busy !== null || dirty}
              title={
                dirty ? "Save local changes before forking the profile" : undefined
              }
              className={secondaryButtonClass}
            >
              Duplicate
            </button>
          )}
          {mode === "overview" && editable && (
            <button
              type="button"
              onClick={() => setMode("edit")}
              disabled={busy !== null}
              className={primaryButtonClass}
            >
              Edit draft
            </button>
          )}
          {mode === "edit" && editable && (
            <>
              <button
                type="button"
                onClick={discardLocalChanges}
                disabled={busy !== null}
                className={secondaryButtonClass}
              >
                Discard changes
              </button>
              <button
                type="button"
                onClick={() => void onSave(draft)}
                disabled={busy !== null || !dirty || !valid}
                className={primaryButtonClass}
              >
                {busy === "save" ? "Saving…" : "Save draft"}
              </button>
            </>
          )}
          {mode === "review" && editable && (
            <>
              <button
                type="button"
                onClick={() => setMode("edit")}
                disabled={busy !== null}
                className={secondaryButtonClass}
              >
                Back to edit
              </button>
              <button
                type="button"
                onClick={() => void onPublish()}
                disabled={busy !== null || dirty || !valid}
                className={primaryButtonClass}
              >
                {busy === "publish"
                  ? "Publishing…"
                  : `Publish v${(profile.publishedVersion ?? 0) + 1}`}
              </button>
            </>
          )}
        </div>
      </div>

      {mode === "overview" &&
        editable &&
        draftChangedFromPublished &&
        !dirty && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-[3px] border border-mariner-200 bg-mariner-50 px-3 py-2">
            <span className="font-body text-[12px] text-mariner">
              This draft has unpublished changes since{" "}
              {profile.publishedVersion === null
                ? "it was created"
                : `v${profile.publishedVersion}`}.
            </span>
            <button
              type="button"
              onClick={() => setMode("review")}
              className="appearance-none border-none bg-transparent font-body text-[11px] font-semibold text-mariner cursor-pointer"
            >
              Review changes
            </button>
          </div>
        )}

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700"
        >
          {error}
        </div>
      )}

      {!editable && (
        <div className="mb-3 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          {profile.system || profile.readOnly
            ? "This system profile is read-only. Fork it to create an organization-owned profile."
            : profile.archivedAt
              ? "This profile is archived. Existing pinned workflows keep working, but the profile cannot be changed or newly selected."
              : "Read-only — organization owners and admins manage harness profiles."}
        </div>
      )}

      {showFork && canManageProfiles && (
        <div className="mb-3 flex flex-col gap-2 rounded-[3px] border border-neutral-200 bg-panel p-3 sm:flex-row sm:items-end">
          <Field
            label="New profile slug"
            hint={
              forkSlug !== "" && !isProfileSlug(forkSlug.trim())
                ? "Use 1–64 lowercase letters, numbers, or hyphens."
                : "Forks the latest stored draft into an independent profile."
            }
          >
            <input
              aria-label="New profile slug"
              value={forkSlug}
              maxLength={64}
              onChange={(event) => setForkSlug(event.target.value)}
              placeholder={`${profile.slug}-custom`}
              className={inputClass}
            />
          </Field>
          <button
            type="button"
            onClick={() => void onFork(forkSlug.trim())}
            disabled={busy !== null || !isProfileSlug(forkSlug.trim())}
            className={primaryButtonClass}
          >
            {busy === "fork" ? "Forking…" : "Create fork"}
          </button>
          <button
            type="button"
            onClick={() => setShowFork(false)}
            disabled={busy !== null}
            className={secondaryButtonClass}
          >
            Cancel
          </button>
        </div>
      )}

      {mode === "overview" && (
        <div className="grid min-h-[560px] gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0">
            <div className="rounded-[4px] border border-neutral-200 bg-panel">
              {[
                {
                  label: "Runtime",
                  values: [
                    ["Provider / model", `${draft.harness.provider} · ${draft.model.id}`],
                    [
                      "Exact CLI / protocol",
                      `${draft.harness.cliVersion} · ${draft.harness.protocolVersion}`,
                    ],
                  ],
                },
                {
                  label: "Context",
                  values: [
                    [
                      "Repository instructions",
                      draft.context.includeRepositoryInstructions
                        ? "Included"
                        : "Excluded",
                    ],
                    [
                      "Workflow data",
                      draft.context.includeWorkflowData ? "Included" : "Excluded",
                    ],
                    [
                      "Compaction",
                      draft.schemaVersion === 1
                        ? "Provider default"
                        : draft.compaction.mode === "model_default"
                          ? "Model default"
                          : draft.compaction.mode === "disabled"
                            ? "Disabled"
                            : `${draft.compaction.thresholdPercent}% · ${draft.compaction.thresholdTokens} tokens`,
                    ],
                    [
                      "Reasoning",
                      draft.schemaVersion === 1
                        ? "Provider default"
                        : draft.model.reasoning.selection === "model_default"
                          ? `Model default · ${draft.model.reasoning.effectiveEffort}`
                          : draft.model.reasoning.effectiveEffort,
                    ],
                  ],
                },
                {
                  label: "Capabilities",
                  values: [
                    ["Runtime tools", draft.tools.join(", ")],
                    [
                      "Subagents",
                      draft.subagents.enabled
                        ? `Up to ${draft.subagents.maxConcurrent}`
                        : "Disabled",
                    ],
                  ],
                },
                {
                  label: "Instructions",
                  values: [
                    [
                      "Profile instructions",
                      draft.instructions.trim() === ""
                        ? "None"
                        : `${draft.instructions.split("\n").length} ${
                            draft.instructions.split("\n").length === 1
                              ? "line"
                              : "lines"
                          }`,
                    ],
                    [
                      "Safe home files",
                      `${draft.homeFiles.length} ${draft.homeFiles.length === 1 ? "file" : "files"}`,
                    ],
                  ],
                },
                {
                  label: "Limits",
                  values: [
                    [
                      "Duration",
                      draft.limits.maxDurationMs === null
                        ? "Inherited"
                        : `${draft.limits.maxDurationMs} ms`,
                    ],
                    [
                      "Tokens",
                      draft.limits.maxTokens === null
                        ? "Inherited"
                        : String(draft.limits.maxTokens),
                    ],
                    [
                      "Cost",
                      draft.limits.maxCostUsd === null
                        ? "Inherited"
                        : `$${draft.limits.maxCostUsd}`,
                    ],
                  ],
                },
              ].map((section) => (
                <div
                  key={section.label}
                  className="grid gap-3 border-b border-neutral-100 px-4 py-4 last:border-b-0 md:grid-cols-[100px_minmax(0,1fr)]"
                >
                  <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-neutral-500">
                    {section.label}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {section.values.map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <div className="font-body text-[10px] text-neutral-500">
                          {label}
                        </div>
                        <div className="mt-0.5 break-words font-body text-[11px] text-coal">
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5">
              <div className="mb-2 flex items-end justify-between gap-3">
                <div>
                  <h2 className="m-0 font-body text-[15px] font-semibold text-coal">
                    Skills
                  </h2>
                  <p className="mt-1 mb-0 font-body text-[11px] text-neutral-500">
                    Skills are pinned to exact Git commits for reproducibility.
                  </p>
                </div>
                {editable && (
                  <button
                    type="button"
                    onClick={() => setShowSkillImport(true)}
                    className={primaryButtonClass}
                  >
                    Add from GitHub
                  </button>
                )}
              </div>
              <div className="overflow-hidden rounded-[4px] border border-neutral-200 bg-panel">
                {draft.skills.length === 0 ? (
                  <div className="px-4 py-8 text-center font-body text-[12px] text-neutral-500">
                    No skills are attached to this profile.
                  </div>
                ) : (
                  draft.skills.map((skill) => (
                    <div
                      key={skill.artifactHash}
                      className="grid gap-2 border-b border-neutral-100 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_180px]"
                    >
                      <div>
                        <div className="font-mono text-[11px] font-semibold text-coal">
                          {skill.name}
                        </div>
                        <div className="mt-0.5 font-body text-[10px] text-neutral-500">
                          Immutable GitHub skill artifact
                        </div>
                      </div>
                      <div className="truncate font-mono text-[9px] text-neutral-500">
                        {skill.artifactHash}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {usage.length > 0 && (
              <div className="mt-5 rounded-[4px] border border-neutral-200 bg-panel p-4">
                <h2 className="m-0 font-body text-[14px] font-semibold text-coal">
                  Used by {usage.length}{" "}
                  {usage.length === 1 ? "workflow" : "workflows"}
                </h2>
                <div className="mt-2 flex flex-col gap-2">
                  {usage.map((workflowUsage) => (
                    <div
                      key={workflowUsage.definitionId}
                      className="flex items-center justify-between gap-3 font-body text-[11px]"
                    >
                      <span className="text-coal">{workflowUsage.name}</span>
                      <span className="font-mono text-[9px] text-neutral-500">
                        v{workflowUsage.versions.join(", v")}
                        {workflowUsage.deployed ? " · deployed" : " · draft"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="self-start rounded-[4px] border border-neutral-200 bg-panel p-4">
            <h2 className="m-0 font-body text-[14px] font-semibold text-coal">
              Version history
            </h2>
            <p className="mt-1 mb-3 font-body text-[10px] text-neutral-500">
              All published versions are immutable.
            </p>
            {detail.versions.length === 0 ? (
              <div className="rounded-[3px] border border-dashed border-neutral-200 p-3 font-body text-[11px] text-neutral-500">
                Publish the draft to create the first version.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {detail.versions.map((version) => (
                  <div
                    key={version.version}
                    className={`rounded-[3px] border p-3 ${
                      version.version === profile.publishedVersion
                        ? "border-mariner bg-mariner-50"
                        : "border-neutral-200"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12px] font-semibold text-coal">
                        v{version.version}
                      </span>
                      {version.version === profile.publishedVersion && (
                        <CkChip tone="success">Published</CkChip>
                      )}
                    </div>
                    <div className="mt-1 font-body text-[10px] text-neutral-500">
                      {new Date(version.createdAt).toLocaleString()}
                    </div>
                    <div className="mt-1 truncate font-mono text-[9px] text-neutral-500">
                      {version.manifestHash}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setInspectedVersion((current) =>
                          current === version.version ? null : version.version,
                        )
                      }
                      className="mt-2 appearance-none border-none bg-transparent p-0 font-body text-[10px] font-semibold text-mariner cursor-pointer"
                    >
                      {inspectedVersion === version.version
                        ? "Hide details"
                        : "View details"}
                    </button>
                    {inspectedVersion === version.version && (
                      <div className="mt-2 border-t border-neutral-200 pt-2 font-body text-[10px] text-neutral-600">
                        <div>{version.manifest.model.id}</div>
                        <div>
                          {version.manifest.harness.packageName}@
                          {version.manifest.harness.cliVersion}
                        </div>
                        <div>
                          {version.manifest.skills.length}{" "}
                          {version.manifest.skills.length === 1
                            ? "skill"
                            : "skills"}
                        </div>
                      </div>
                    )}
                    {editable &&
                      version.version !== profile.publishedVersion && (
                        <button
                          type="button"
                          onClick={() => setConfirmRestore(version.version)}
                          disabled={busy !== null}
                          className="mt-2 appearance-none border-none bg-transparent p-0 font-body text-[10px] font-semibold text-mariner cursor-pointer"
                        >
                          Restore into draft
                        </button>
                      )}
                    {confirmRestore === version.version && (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => void onRestore(version.version)}
                          className="appearance-none border-none bg-transparent p-0 font-body text-[10px] font-semibold text-red-600 cursor-pointer"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRestore(null)}
                          className="appearance-none border-none bg-transparent p-0 font-body text-[10px] text-neutral-500 cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}

      {mode === "review" && (
        <div className="rounded-[4px] border border-neutral-200 bg-panel">
          <div className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] border-b border-neutral-200 bg-app-bg px-4 py-2 font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500">
            <span>Section</span>
            <span>Published {profile.publishedVersion ? `v${profile.publishedVersion}` : ""}</span>
            <span>Draft v{(profile.publishedVersion ?? 0) + 1}</span>
          </div>
          {[
            [
              "Model",
              published?.manifest.model.id ?? "Not published",
              draft.model.id,
            ],
            [
              "Instructions",
              published
                ? `${published.manifest.instructions.split("\n").length} lines`
                : "Not published",
              `${draft.instructions.split("\n").length} lines`,
            ],
            [
              "Skills",
              published
                ? `${published.manifest.skills.length} skills`
                : "Not published",
              `${draft.skills.length} skills`,
            ],
            [
              "Limits",
              published ? "Immutable published limits" : "Not published",
              "Current draft limits",
            ],
          ].map(([section, before, after]) => (
            <div
              key={section}
              className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] border-b border-neutral-100 px-4 py-4 font-body text-[11px] last:border-b-0"
            >
              <span className="font-semibold text-coal">{section}</span>
              <span className="text-neutral-600">{before}</span>
              <span className={before === after ? "text-neutral-600" : "text-green-700"}>
                {after}
              </span>
            </div>
          ))}
          <div className="border-t border-neutral-200 bg-app-bg px-4 py-3 font-body text-[11px] text-neutral-600">
            Publishing creates an immutable version. Existing workflows remain
            pinned until they are explicitly updated.
          </div>
        </div>
      )}

      {mode === "edit" && (
      <div className="grid gap-5 xl:grid-cols-[140px_minmax(0,1fr)]">
        <nav
          aria-label="Profile draft sections"
          className="flex gap-1 overflow-x-auto xl:flex-col"
        >
          {[
            ["general", "General"],
            ["context", "Context"],
            ["instructions", "Instructions"],
            ["skills", "Skills"],
            ["tools", "Tools & integrations"],
            ["limits", "Limits & workspace"],
            ["home-files", "Home files"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                setEditSection(
                  id as
                    | "general"
                    | "context"
                    | "instructions"
                    | "skills"
                    | "tools"
                    | "limits"
                    | "home-files",
                )
              }
              className={`appearance-none border-none border-l-2 bg-transparent px-3 py-2 text-left font-body text-[11px] cursor-pointer ${
                editSection === id
                  ? "border-mariner text-mariner font-semibold"
                  : "border-transparent text-neutral-600 hover:text-coal"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
        <CkCard
          title="Identity and harness"
          eyebrow="Profile draft"
          className={editSection === "general" ? "" : "hidden"}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name">
              <input
                aria-label="Profile display name"
                value={draft.displayName}
                maxLength={120}
                disabled={!editable}
                onChange={(event) => update({ displayName: event.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Provider">
              <Listbox
                options={[
                  { value: "codex", label: "Codex" },
                  { value: "claude", label: "Claude" },
                ]}
                value={draft.harness.provider}
                disabled={!editable || capabilityLoading}
                ariaLabel="Harness provider"
                onChange={(providerValue) => {
                  const provider =
                    providerValue === "claude" ? "claude" : "codex";
                  void switchProvider(provider);
                }}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description">
                <textarea
                  aria-label="Profile description"
                  value={draft.description}
                  maxLength={2_000}
                  disabled={!editable}
                  onChange={(event) => update({ description: event.target.value })}
                  className={textareaClass}
                />
              </Field>
            </div>
            <Field label="CLI package">
              <input
                aria-label="CLI package"
                value={draft.harness.packageName}
                disabled
                className={inputClass}
              />
            </Field>
            <Field
              label="Exact CLI version"
              hint="Runs always materialize this pinned version."
            >
              <input
                aria-label="Exact CLI version"
                value={draft.harness.cliVersion}
                disabled
                className={inputClass}
              />
            </Field>
            <Field label="Protocol version">
              <input
                aria-label="Protocol version"
                value={draft.harness.protocolVersion}
                disabled
                className={inputClass}
              />
            </Field>
            <Field label="Model">
              <div className="flex flex-col gap-1">
                <input
                  aria-label="Search models"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="Search models…"
                  disabled={!editable || capabilityLoading}
                  className={inputClass}
                />
                <Listbox
                  options={[
                    ...(!catalogModels.some(
                      (model) => model.id === draft.model.id,
                    )
                      ? [
                          {
                            value: draft.model.id,
                            label: `${draft.model.id} · unavailable`,
                            hint:
                              "Historical selection; choose a current model before publishing.",
                          },
                        ]
                      : []),
                    ...filteredModels.map((model) => ({
                      value: model.id,
                      label: model.name,
                      hint: model.id,
                    })),
                  ]}
                  value={draft.model.id}
                  disabled={
                    !editable ||
                    capabilityLoading ||
                    !capabilities ||
                    capabilities.stale
                  }
                  ariaLabel="Model"
                  onChange={(modelId) => {
                    const model = catalogModels.find(
                      (candidate) => candidate.id === modelId,
                    );
                    if (model) selectModel(model);
                  }}
                />
              </div>
            </Field>
            {draft.schemaVersion === 1 && (
              <Field
                label="Model options"
                hint="Historical v1 versions retain provider-default model options."
              >
                <input
                  aria-label="Model options"
                  value={
                    Object.keys(draft.model.options).length === 0
                      ? "Provider default"
                      : "Unsupported historical options"
                  }
                  disabled
                  className={inputClass}
                />
              </Field>
            )}
            {capabilityLoading && (
              <div className="sm:col-span-2 font-body text-[11px] text-neutral-500">
                Loading capabilities…
              </div>
            )}
            {capabilityError && (
              <div
                role="alert"
                className="sm:col-span-2 rounded-[3px] border border-red-200 bg-red-50 px-3 py-2 font-body text-[11px] text-red-700"
              >
                {capabilityError}
              </div>
            )}
            {capabilities?.stale && (
              <div className="sm:col-span-2 rounded-[3px] border border-amber-200 bg-amber-50 px-3 py-2 font-body text-[11px] text-amber-800">
                Showing the last safe capability catalog. Refresh must
                succeed before this profile can be published.
              </div>
            )}
            {draft.schemaVersion === 2 && (
              <>
                <Field label="Reasoning effort">
                  <Listbox
                    options={[
                      {
                        value: "model_default",
                        label: `Model default · ${draft.model.capability.defaultReasoningEffort ?? draft.model.reasoning.effectiveEffort}`,
                      },
                      ...draft.model.capability.reasoningEfforts.map(
                        (effort) => ({
                          value: effort.id,
                          label: effort.name,
                          hint: effort.description ?? undefined,
                        }),
                      ),
                    ]}
                    value={draft.model.reasoning.selection}
                    disabled={!editable || capabilities?.stale !== false}
                    ariaLabel="Reasoning effort"
                    onChange={(selection) => {
                      const effectiveEffort =
                        selection === "model_default"
                          ? draft.model.capability.defaultReasoningEffort
                          : selection;
                      if (!effectiveEffort) return;
                      setDraft((current) =>
                        current.schemaVersion === 2
                          ? {
                              ...current,
                              model: {
                                ...current.model,
                                reasoning: {
                                  selection,
                                  effectiveEffort,
                                },
                              },
                            }
                          : current,
                      );
                    }}
                  />
                </Field>
                <Field label="Speed">
                  <Listbox
                    options={draft.model.capability.serviceTiers.map(
                      (tier) => ({
                        value: tier.id,
                        label: tier.name,
                        hint: tier.description ?? undefined,
                      }),
                    )}
                    value={draft.model.serviceTier}
                    disabled={!editable || capabilities?.stale !== false}
                    ariaLabel="Service tier"
                    onChange={(serviceTier) =>
                      setDraft((current) =>
                        current.schemaVersion === 2
                          ? {
                              ...current,
                              model: { ...current.model, serviceTier },
                            }
                          : current,
                      )
                    }
                  />
                </Field>
                {draft.model.capability.verbosityOptions.length > 0 && (
                  <Field label="Response verbosity">
                    <Listbox
                      options={draft.model.capability.verbosityOptions.map(
                        (verbosity) => ({
                          value: verbosity.id,
                          label: verbosity.name,
                          hint: verbosity.description ?? undefined,
                        }),
                      )}
                      value={draft.model.verbosity ?? ""}
                      disabled={!editable || capabilities?.stale !== false}
                      ariaLabel="Response verbosity"
                      onChange={(verbosity) =>
                        setDraft((current) =>
                          current.schemaVersion === 2
                            ? {
                                ...current,
                                model: { ...current.model, verbosity },
                              }
                            : current,
                        )
                      }
                    />
                  </Field>
                )}
                <Field label="Context window">
                  <input
                    aria-label="Context window"
                    value={
                      draft.model.capability.contextWindowTokens === null
                        ? "Not advertised"
                        : `${draft.model.capability.contextWindowTokens.toLocaleString()} tokens`
                    }
                    disabled
                    className={inputClass}
                  />
                </Field>
              </>
            )}
          </div>
        </CkCard>

        <CkCard
          title={editSection === "instructions" ? "Instructions" : "Context"}
          eyebrow="Effective prompt"
          className={
            editSection === "context" || editSection === "instructions"
              ? ""
              : "hidden"
          }
        >
          <div className="flex flex-col gap-3">
            <Field
              label="Profile instructions"
              hint="These instructions are compiled before the block's editable role prompt."
            >
              <textarea
                aria-label="Profile instructions"
                value={draft.instructions}
                maxLength={100_000}
                disabled={!editable}
                onChange={(event) => update({ instructions: event.target.value })}
                className={`${textareaClass} min-h-[128px]`}
              />
            </Field>
            <div>
              <CheckboxField
                label="Always include repository AGENTS.md / CLAUDE.md instructions"
                checked={draft.context.includeRepositoryInstructions}
                disabled
                onChange={() => undefined}
              />
              <div className="mt-1 font-body text-[10px] text-neutral-500">
                Fixed by the current CLI contract; profiles cannot disable
                repository instruction discovery.
              </div>
            </div>
            <CheckboxField
              label="Include workflow data"
              checked={draft.context.includeWorkflowData}
              disabled={!editable}
              onChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  context: {
                    ...current.context,
                    includeWorkflowData: checked,
                  },
                }))
              }
            />
            <Field
              label="Compaction"
              hint={
                draft.schemaVersion === 1
                  ? "Historical v1 versions retain provider-default behavior."
                  : "Custom thresholds are stored as both a percentage and the exact provider-native token value."
              }
            >
              {draft.schemaVersion === 1 ? (
                <input
                  aria-label="Compaction"
                  value="Provider default"
                  disabled
                  className={inputClass}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  <Listbox
                    options={draft.model.capability.compactionModes
                      .filter(
                        (modeValue) =>
                          modeValue !== "custom_threshold" ||
                          draft.model.capability.contextWindowTokens !== null,
                      )
                      .map((modeValue) => ({
                        value: modeValue,
                        label:
                          modeValue === "model_default"
                            ? "Model default"
                            : modeValue === "custom_threshold"
                              ? "Custom threshold"
                              : "Disabled",
                      }))}
                    value={draft.compaction.mode}
                    disabled={!editable || capabilities?.stale !== false}
                    ariaLabel="Compaction"
                    onChange={(compactionMode) => {
                      if (compactionMode === "model_default") {
                        setDraft((current) =>
                          current.schemaVersion === 2
                            ? {
                                ...current,
                                compaction: { mode: "model_default" },
                              }
                            : current,
                        );
                      } else if (compactionMode === "disabled") {
                        setDraft((current) =>
                          current.schemaVersion === 2
                            ? {
                                ...current,
                                compaction: { mode: "disabled" },
                              }
                            : current,
                        );
                      } else {
                        const thresholdPercent = 80;
                        setDraft((current) =>
                          current.schemaVersion === 2 &&
                          current.model.capability.contextWindowTokens !== null
                            ? {
                                ...current,
                                compaction: {
                                  mode: "custom_threshold",
                                  thresholdPercent,
                                  thresholdTokens: Math.floor(
                                    (current.model.capability
                                      .contextWindowTokens *
                                      thresholdPercent) /
                                      100,
                                  ),
                                },
                              }
                            : current,
                        );
                      }
                    }}
                  />
                  {draft.compaction.mode === "custom_threshold" && (
                    <label className="flex flex-col gap-1">
                      <span className="font-body text-[10px] text-neutral-500">
                        Compact at {draft.compaction.thresholdPercent}% (
                        {draft.compaction.thresholdTokens.toLocaleString()}{" "}
                        tokens)
                      </span>
                      <input
                        aria-label="Compaction threshold percentage"
                        type="range"
                        min={1}
                        max={99}
                        value={draft.compaction.thresholdPercent}
                        disabled={!editable || capabilities?.stale !== false}
                        onChange={(event) => {
                          const thresholdPercent = Number(
                            event.target.value,
                          );
                          const contextWindow =
                            draft.model.capability.contextWindowTokens;
                          if (contextWindow === null) return;
                          setDraft((current) =>
                            current.schemaVersion === 2
                              ? {
                                  ...current,
                                  compaction: {
                                    mode: "custom_threshold",
                                    thresholdPercent,
                                    thresholdTokens: Math.floor(
                                      (contextWindow * thresholdPercent) / 100,
                                    ),
                                  },
                                }
                              : current,
                          );
                        }}
                        className="w-full accent-mariner"
                      />
                    </label>
                  )}
                </div>
              )}
            </Field>
          </div>
        </CkCard>

        <CkCard
          title="Limits and workspace"
          eyebrow="Runtime behavior"
          className={editSection === "limits" ? "" : "hidden"}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <CheckboxField
                label="Profile requests subagents"
                checked={draft.subagents.enabled}
                disabled
                onChange={() => undefined}
              />
              <div className="mt-1 font-body text-[10px] text-neutral-500">
                Read-only declaration. Current provider adapters always clip
                subagent access.
              </div>
            </div>
            <Field
              label="Declared max concurrent subagents"
              hint="Stored for compatibility; it is not an effective runtime limit yet."
            >
              <input
                aria-label="Declared maximum concurrent subagents"
                value={draft.subagents.maxConcurrent}
                disabled
                className={inputClass}
              />
            </Field>
            <Field label="Max duration (ms)" hint="Blank inherits the workflow limit.">
              <input
                aria-label="Maximum duration in milliseconds"
                type="number"
                min={1}
                max={86_400_000}
                value={draft.limits.maxDurationMs ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    limits: {
                      ...current.limits,
                      maxDurationMs: nullableNumber(event.target.value),
                    },
                  }))
                }
                className={inputClass}
              />
            </Field>
            <Field label="Max tokens" hint="Blank inherits the workflow limit.">
              <input
                aria-label="Maximum tokens"
                type="number"
                min={1}
                max={10_000_000}
                value={draft.limits.maxTokens ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    limits: {
                      ...current.limits,
                      maxTokens: nullableNumber(event.target.value),
                    },
                  }))
                }
                className={inputClass}
              />
            </Field>
            <Field label="Max cost (USD)" hint="Blank inherits the workflow limit.">
              <input
                aria-label="Maximum cost in USD"
                type="number"
                min={0.01}
                max={100_000}
                step="0.01"
                value={draft.limits.maxCostUsd ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    limits: {
                      ...current.limits,
                      maxCostUsd: nullableNumber(event.target.value),
                    },
                  }))
                }
                className={inputClass}
              />
            </Field>
            <Field
              label="Workspace mode"
              hint="The current runtime supports managed workspaces only."
            >
              <input
                aria-label="Workspace mode"
                value="Managed workspace"
                disabled
                className={inputClass}
              />
            </Field>
            <div className="sm:col-span-2">
              <CheckboxField
                label="Reuse the managed scratch workspace across compatible blocks"
                checked={draft.workspace.preserveAcrossBlocks}
                disabled={!editable}
                onChange={(checked) =>
                  setDraft((current) => ({
                    ...current,
                    workspace: {
                      ...current.workspace,
                      preserveAcrossBlocks: checked,
                    },
                  }))
                }
              />
              <div className="mt-1 font-body text-[10px] text-neutral-500">
                Turning this off creates a fresh scratch workspace per
                invocation. Code-workspace agent blocks require it to stay on.
              </div>
            </div>
          </div>
        </CkCard>

        <CkCard
          title="Tools and integrations"
          eyebrow="Declared capabilities"
          className={editSection === "tools" ? "" : "hidden"}
        >
          <div className="flex flex-col gap-3">
            <Field
              label="Runtime tool set"
              hint={
                hasCompleteRuntimeToolSet
                  ? "The current provider adapters require this complete code-owned set. A block may still clip tools through its safety envelope."
                  : "This draft is missing a required runtime tool and cannot be saved."
              }
            >
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {HARNESS_TOOL_IDS.map((tool) => (
                  <CheckboxField
                    key={tool}
                    label={tool}
                    checked={draft.tools.includes(tool)}
                    disabled
                    onChange={() => undefined}
                  />
                ))}
              </div>
            </Field>
            <Field
              label="MCP integrations"
              hint="None are available until an integration has a code-owned runtime materializer."
            >
              <input
                aria-label="MCP integrations"
                value="None available"
                disabled
                className={inputClass}
              />
            </Field>
            <Field
              label="Credential references"
              hint="Symbolic references only. Credential values are resolved at runtime and never stored here."
            >
              <input
                aria-label="Credential references"
                value={
                  draft.harness.provider === "claude" ? "anthropic" : "openai"
                }
                disabled
                className={inputClass}
              />
            </Field>
          </div>
        </CkCard>

        <CkCard
          title="Skills"
          eyebrow="Immutable artifacts"
          className={editSection === "skills" ? "" : "hidden"}
        >
          <div className="flex flex-col gap-2">
            {draft.skills.length === 0 && (
              <div className="rounded-[3px] border border-dashed border-neutral-300 px-3 py-4 font-body text-[11px] text-neutral-500">
                No skills are attached to this profile.
              </div>
            )}
            {draft.skills.map((skill) => {
              const artifact = importedArtifacts.get(skill.artifactHash);
              return (
                <div
                  key={skill.artifactHash}
                  className="rounded-[3px] border border-neutral-200 bg-panel px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[11px] font-semibold text-coal">
                        {skill.name}
                      </div>
                      <div className="truncate font-mono text-[9px] text-neutral-500">
                        {skill.artifactHash}
                      </div>
                      {artifact && (
                        <div className="mt-1 font-mono text-[9px] text-neutral-500">
                          {artifact.source.owner}/{artifact.source.repository} @{" "}
                          {artifact.source.commitSha.slice(0, 12)} ·{" "}
                          {artifact.files.length} files
                        </div>
                      )}
                    </div>
                    {editable && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void onRefreshSkill(skill.artifactHash)}
                          disabled={busy !== null || dirty}
                          title={
                            dirty
                              ? "Save local profile changes before refreshing a skill"
                              : "Discover the latest commit and update only this profile draft"
                          }
                          className="appearance-none border-none bg-transparent p-0 font-body text-[11px] text-mariner cursor-pointer disabled:cursor-default disabled:opacity-40"
                        >
                          {busy === `refresh-${skill.artifactHash}`
                            ? "Refreshing…"
                            : "Refresh"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              skills: current.skills.filter(
                                (candidate) =>
                                  candidate.artifactHash !== skill.artifactHash,
                              ),
                            }))
                          }
                          disabled={busy !== null}
                          className="appearance-none border-none bg-transparent p-0 font-body text-[11px] text-red-600 cursor-pointer disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {editable && (
              <button
                type="button"
                onClick={() => setShowSkillImport(true)}
                disabled={busy !== null}
                className={secondaryButtonClass}
              >
                Add from GitHub
              </button>
            )}
          </div>
        </CkCard>

        <CkCard
          title="Safe home files"
          eyebrow="Pinned runtime files"
          className={editSection === "home-files" ? "" : "hidden"}
        >
          <Field
            label="Files (JSON array)"
            hint={
              homeFilesError
                ? `Use at most one ${draft.harness.provider === "codex" ? "AGENTS.md" : "CLAUDE.md"} file with string content and mode 420 (0644).`
                : `The current ${draft.harness.provider === "codex" ? "Codex" : "Claude"} runtime accepts only an optional ${draft.harness.provider === "codex" ? "AGENTS.md" : "CLAUDE.md"} file. Credential material is injected separately.`
            }
          >
            <textarea
              aria-label="Safe home files"
              value={homeFilesSource}
              disabled={!editable}
              aria-invalid={homeFilesError}
              onChange={(event) => {
                const source = event.target.value;
                setHomeFilesSource(source);
                const value = parseHomeFiles(
                  source,
                  draft.harness.provider,
                );
                setHomeFilesError(value === null);
                if (value) update({ homeFiles: value });
              }}
              className={`${textareaClass} min-h-[180px] ${homeFilesError ? "border-red-400" : ""}`}
            />
          </Field>
        </CkCard>

        <CkCard
          title="Published versions"
          eyebrow={published ? `Current v${published.version}` : "Not published"}
          className="hidden"
        >
          {detail.versions.length === 0 ? (
            <div className="font-body text-[12px] text-neutral-500">
              Publish the draft to create the first immutable version.
            </div>
          ) : (
            <div>
              {detail.versions.map((version) => (
                <div
                  key={version.version}
                  className="flex flex-wrap items-center gap-3 border-b border-neutral-100 py-2 font-body text-[11px] text-neutral-700 last:border-b-0"
                >
                  <span className="font-mono font-semibold text-coal">
                    v{version.version}
                  </span>
                  <span className="font-mono text-[9px] text-neutral-500">
                    {version.manifestHash}
                  </span>
                  <span className="text-neutral-500">
                    {new Date(version.createdAt).toLocaleString()}
                  </span>
                  {version.restoredFromVersion !== null && (
                    <CkChip>restored from v{version.restoredFromVersion}</CkChip>
                  )}
                  {editable &&
                    version.version !== profile.publishedVersion && (
                      <span className="ml-auto">
                        {confirmRestore === version.version ? (
                          <span className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void onRestore(version.version)}
                              disabled={busy !== null || dirty}
                              className="appearance-none border-none bg-transparent p-0 font-body text-[11px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                            >
                              {busy === `restore-${version.version}`
                                ? "Restoring…"
                                : "Confirm restore"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRestore(null)}
                              className="appearance-none border-none bg-transparent p-0 font-body text-[11px] text-neutral-500 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRestore(version.version)}
                            disabled={busy !== null || dirty}
                            title={
                              dirty
                                ? "Save local changes before restoring a version"
                                : undefined
                            }
                            className="appearance-none border-none bg-transparent p-0 font-body text-[11px] text-mariner cursor-pointer disabled:opacity-40"
                          >
                            Restore to draft
                          </button>
                        )}
                      </span>
                    )}
                </div>
              ))}
            </div>
          )}
        </CkCard>
        </div>
      </div>
      )}

      {canManageProfiles && !profile.system && mode === "overview" && (
        <div className="mt-6 border-t border-neutral-200 pt-4">
          {profile.archivedAt ? (
            <button
              type="button"
              onClick={() => void onUnarchive()}
              disabled={busy !== null}
              className={secondaryButtonClass}
            >
              {busy === "unarchive" ? "Restoring…" : "Restore profile"}
            </button>
          ) : detail.canDeleteProfile === true ? (
            confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 font-body text-[12px] text-neutral-700">
                <span>
                  Permanently delete this unused unpublished draft? This cannot
                  be undone.
                </span>
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={busy !== null}
                  className="appearance-none border-none bg-transparent p-0 font-body text-[12px] font-semibold text-red-600 cursor-pointer"
                >
                  {busy === "remove" ? "Deleting…" : "Delete profile"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="appearance-none border-none bg-transparent p-0 font-body text-[12px] text-neutral-500 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy !== null}
                className="appearance-none border-none bg-transparent p-0 font-body text-[12px] text-red-600 cursor-pointer"
              >
                Delete unused draft
              </button>
            )
          ) : confirmArchive ? (
            <div className="flex flex-wrap items-center gap-2 font-body text-[12px] text-neutral-700">
              <span>
                Archive this profile? Existing pinned workflows will keep their
                exact version.
              </span>
              <button
                type="button"
                onClick={() => void onArchive()}
                disabled={busy !== null || dirty}
                className="appearance-none border-none bg-transparent p-0 font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
              >
                {busy === "archive" ? "Archiving…" : "Confirm archive"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmArchive(false)}
                className="appearance-none border-none bg-transparent p-0 font-body text-[12px] text-neutral-500 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmArchive(true)}
              disabled={busy !== null || dirty}
              title={
                dirty ? "Save local changes before archiving" : undefined
              }
              className="appearance-none border-none bg-transparent p-0 font-body text-[12px] text-red-600 cursor-pointer disabled:opacity-40"
            >
              Archive profile
            </button>
          )}
        </div>
      )}

      <SkillImport
        open={showSkillImport}
        disabled={!editable || busy !== null}
        onClose={() => setShowSkillImport(false)}
        onImported={(skills, artifacts) => {
          setDraft((current) => ({
            ...current,
            skills: mergeSkills(current.skills, skills),
          }));
          setImportedArtifacts((current) => {
            const next = new Map(current);
            for (const artifact of artifacts) {
              next.set(artifact.artifactHash, artifact);
            }
            return next;
          });
          setShowSkillImport(false);
          setMode("edit");
        }}
      />
    </div>
  );
}

export type { ProfileAction };
