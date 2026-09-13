"use client";

import { useEffect, useState } from "react";

import { Button, CkCard, CkChip, Input, Select, Textarea } from "@/components/ui";
import { SkillImport } from "./skill-import";
import {
  canEditProfile,
  isProfileSlug,
  newProfileDraft,
  upgradeProfileDraft,
  selectableHarnessModels,
  withHarnessModel,
  withHarnessProvider,
} from "@/lib/harness-profiles/editor";
import { apiClient } from "@/lib/api/client";
import type {
  HarnessCapabilitiesResponse,
  HarnessLocalSkillDiscoveryResponse,
  HarnessProvider,
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifest,
  HarnessProfileDraftManifestV1,
  HarnessProfileSkillReference,
  HarnessSkillArtifact,
  HarnessSkillSource,
} from "@shared/contracts";
import {
  HARNESS_TOOL_IDS,
  stableJson,
} from "@shared/contracts";
import { isGitHubSkillSource } from "@shared/skills";

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
  /** Outcome of the last refresh, keyed by the hash the draft now pins. */
  refreshNotice?: { artifactHash: string; changed: boolean } | null;
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

/**
 * The two variants are told apart by the guard, never by a tag: a tag inside
 * the source object would enter the artifact hash that profiles pin.
 *
 * Both carry a version, because the path alone would read identically before
 * and after a redeploy: the commit for GitHub, the content digest for the
 * deployment, which is what a local skill has instead of a commit.
 */
function skillSourceLabel(source: HarnessSkillSource): string {
  return isGitHubSkillSource(source)
    ? `${source.owner}/${source.repository} @ ${source.commitSha.slice(0, 12)}`
    : `This deployment · skills/${source.path} @ ${source.contentSha256.slice(0, 12)}`;
}

/**
 * Gate for the deployment read: a profile pinning no deployment skill has
 * nothing to compare, so it must not spend a request on every editor opening.
 */
export function pinsDeploymentSkill(
  skills: HarnessProfileSkillReference[],
  source: (artifactHash: string) => HarnessSkillSource | undefined,
): boolean {
  return skills.some((skill) => {
    const pinned = source(skill.artifactHash);
    return pinned !== undefined && !isGitHubSkillSource(pinned);
  });
}

/**
 * Checks a pinned deployment skill against what the running deployment ships.
 * A null discovery is a read that has not landed or has failed, and renders
 * nothing: not knowing is not the same as having drifted.
 *
 * Matching goes by the pinned path, the same coordinate Refresh re-reads, so a
 * renamed directory reads as gone rather than as a new version of the skill.
 * The GitHub variant is out of scope: its version is a commit, which the
 * deployment listing knows nothing about.
 */
export function LocalSkillPinNotice({
  artifactHash,
  source,
  discovery,
}: {
  artifactHash: string;
  source: HarnessSkillSource | undefined;
  discovery: HarnessLocalSkillDiscoveryResponse | null;
}) {
  if (!source || isGitHubSkillSource(source) || !discovery) return null;
  if (discovery.skills.some((skill) => skill.artifactHash === artifactHash)) {
    return (
      <div className="mt-1 font-body text-[10px] text-neutral-600">
        Matches skills/{source.path} in this deployment.
      </div>
    );
  }
  return (
    <div className="mt-1 font-body text-[10px] text-amber-700">
      {discovery.skills.some((skill) => skill.path === source.path)
        ? `This deployment ships different contents at skills/${source.path}. Use Refresh to move the pin, then publish the profile.`
        : `This deployment no longer ships skills/${source.path}. Restore the directory in the repository, or remove this skill from the profile.`}
    </div>
  );
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
  refreshNotice = null,
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
  const [deploymentSkills, setDeploymentSkills] =
    useState<HarnessLocalSkillDiscoveryResponse | null>(null);
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
    // The deployment listing is deliberately kept: it describes the deployment,
    // not this profile, so a save, a refresh or a switch to another profile
    // does not invalidate it. Dropping it here would blank every pin notice
    // right after Refresh, which is the remedy those notices prescribe.
  }, [profile.id, profile.draftRevision, profile.draft]);

  useEffect(() => {
    const controller = new AbortController();
    setCapabilityLoading(true);
    setCapabilityError(null);
    void apiClient.harnessCapabilities.get(
      draft.harness.provider,
      draft.harness.cliVersion,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(response.errorMessage);
        return response.data;
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
  // Two complementary windows: the imported map covers skills added to the
  // unsaved draft, the detail response covers the ones already persisted.
  const persistedSkillSources = new Map(
    detail.skillSources.map((entry) => [entry.artifactHash, entry.source]),
  );
  const skillSource = (artifactHash: string): HarnessSkillSource | undefined =>
    importedArtifacts.get(artifactHash)?.source ??
    persistedSkillSources.get(artifactHash);
  const comparesDeployment = pinsDeploymentSkill(draft.skills, skillSource);

  // A failed read leaves the listing null on purpose: the pin notices then say
  // nothing, because an unanswered deployment is unknown, not drifted.
  useEffect(() => {
    if (!comparesDeployment) return;
    const controller = new AbortController();
    void apiClient.harnessSkills.local({
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.data : null,
      )
      .then((listing) => {
        if (listing && !controller.signal.aborted) setDeploymentSkills(listing);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [comparesDeployment]);
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
      ? selectableHarnessModels(capabilities)
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

  function selectModel(
    model: HarnessCapabilitiesResponse["models"][number],
  ) {
    if (!capabilities || capabilities.stale) return;
    setDraft(
      (current) =>
        withHarnessModel(current, capabilities, model.id) ?? current,
    );
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
    setCapabilityLoading(true);
    setCapabilityError(null);
    try {
      const response = await apiClient.harnessCapabilities.get(
        provider,
        baseline.harness.cliVersion,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(response.errorMessage);
      const targetCapabilities = response.data;
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
            <h1 className="m-0 font-display text-2xl font-semibold text-coal">
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
            <Button
              variant="secondary"
              type="button"
              onClick={() => setShowFork((visible) => !visible)}
              disabled={busy !== null || dirty}
              title={
                dirty ? "Save local changes before forking the profile" : undefined
              }
            >
              Duplicate
            </Button>
          )}
          {mode === "overview" && editable && (
            <Button
              type="button"
              onClick={() => setMode("edit")}
              disabled={busy !== null}
            >
              Edit draft
            </Button>
          )}
          {mode === "edit" && editable && (
            <>
              <Button
                variant="secondary"
                type="button"
                onClick={discardLocalChanges}
                disabled={busy !== null}
              >
                Discard changes
              </Button>
              <Button
                type="button"
                onClick={() => void onSave(draft)}
                disabled={busy !== null || !dirty || !valid}
              >
                {busy === "save" ? "Saving…" : "Save draft"}
              </Button>
            </>
          )}
          {mode === "review" && editable && (
            <>
              <Button
                variant="secondary"
                type="button"
                onClick={() => setMode("edit")}
                disabled={busy !== null}
              >
                Back to edit
              </Button>
              <Button
                type="button"
                onClick={() => void onPublish()}
                disabled={busy !== null || dirty || !valid}
              >
                {busy === "publish"
                  ? "Publishing…"
                  : `Publish v${(profile.publishedVersion ?? 0) + 1}`}
              </Button>
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
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setMode("review")}
            >
              Review changes
            </Button>
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
            : "Read-only: organization owners and admins manage harness profiles."}
        </div>
      )}

      {showFork && canManageProfiles && (
        <div className="mb-3 flex flex-col gap-2 rounded-[3px] border border-neutral-200 bg-panel p-3 sm:flex-row sm:items-end">
          <Field
            label="New profile slug"
            hint={
              forkSlug !== "" && !isProfileSlug(forkSlug.trim())
                ? "Use 1 to 64 lowercase letters, numbers, or hyphens."
                : "Forks the latest stored draft into an independent profile."
            }
          >
            <Input
              monospace
              aria-label="New profile slug"
              value={forkSlug}
              maxLength={64}
              onChange={(event) => setForkSlug(event.target.value)}
              placeholder={`${profile.slug}-custom`}
            />
          </Field>
          <Button
            type="button"
            onClick={() => void onFork(forkSlug.trim())}
            disabled={busy !== null || !isProfileSlug(forkSlug.trim())}
          >
            {busy === "fork" ? "Forking…" : "Create fork"}
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => setShowFork(false)}
            disabled={busy !== null}
          >
            Cancel
          </Button>
        </div>
      )}

      {mode === "overview" && (
        <div className="grid min-h-[560px] gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0">
            <CkCard pad={0}>
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
                  <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500">
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
            </CkCard>

            <div className="mt-5">
              <div className="mb-2 flex items-end justify-between gap-3">
                <div>
                  <h2 className="m-0 font-body text-[15px] font-semibold text-coal">
                    Skills
                  </h2>
                  <p className="mt-1 mb-0 font-body text-[11px] text-neutral-500">
                    Skills are pinned to immutable artifacts: an exact GitHub
                    commit, or the contents this deployment ships.
                  </p>
                </div>
                {editable && (
                  <Button
                    type="button"
                    onClick={() => setShowSkillImport(true)}
                  >
                    Add skills
                  </Button>
                )}
              </div>
              <CkCard pad={0}>
                {draft.skills.length === 0 ? (
                  <div className="px-4 py-8 text-center font-body text-[12px] text-neutral-500">
                    No skills are attached to this profile.
                  </div>
                ) : (
                  draft.skills.map((skill) => {
                    const source = skillSource(skill.artifactHash);
                    return (
                      <div
                        key={skill.artifactHash}
                        className="grid gap-2 border-b border-neutral-100 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_180px]"
                      >
                        <div>
                          <div className="font-mono text-[11px] font-semibold text-coal">
                            {skill.name}
                          </div>
                          <div className="mt-0.5 font-body text-[10px] text-neutral-500">
                            {source
                              ? skillSourceLabel(source)
                              : "Immutable skill artifact"}
                          </div>
                          <LocalSkillPinNotice
                            artifactHash={skill.artifactHash}
                            source={source}
                            discovery={deploymentSkills}
                          />
                        </div>
                        <div className="truncate font-mono text-[9px] text-neutral-500">
                          {skill.artifactHash}
                        </div>
                      </div>
                    );
                  })
                )}
              </CkCard>
            </div>

            {usage.length > 0 && (
              <CkCard className="mt-5">
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
              </CkCard>
            )}
          </div>

          <CkCard className="self-start">
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
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() =>
                        setInspectedVersion((current) =>
                          current === version.version ? null : version.version,
                        )
                      }
                      className="mt-2"
                    >
                      {inspectedVersion === version.version
                        ? "Hide details"
                        : "View details"}
                    </Button>
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
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => setConfirmRestore(version.version)}
                          disabled={busy !== null}
                          className="mt-2"
                        >
                          Restore into draft
                        </Button>
                      )}
                    {confirmRestore === version.version && (
                      <div className="mt-2 flex gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          type="button"
                          onClick={() => void onRestore(version.version)}
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => setConfirmRestore(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CkCard>
        </div>
      )}

      {mode === "review" && (
        <CkCard pad={0}>
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
        </CkCard>
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
            <Button
              variant={editSection === id ? "primary" : "ghost"}
              size="sm"
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
              className="justify-start"
            >
              {label}
            </Button>
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
              <Input
                monospace
                aria-label="Profile display name"
                value={draft.displayName}
                maxLength={120}
                disabled={!editable}
                onChange={(event) => update({ displayName: event.target.value })}
              />
            </Field>
            <Field label="Provider">
              <Select
                size="compact"
                options={[
                  { value: "codex", label: "Codex" },
                  { value: "claude", label: "Claude" },
                ]}
                value={draft.harness.provider}
                disabled={!editable || capabilityLoading}
                aria-label="Harness provider"
                onChange={(providerValue) => {
                  const provider =
                    providerValue === "claude" ? "claude" : "codex";
                  void switchProvider(provider);
                }}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description">
                <Textarea
                  size="sm"
                  monospace
                  aria-label="Profile description"
                  value={draft.description}
                  maxLength={2_000}
                  disabled={!editable}
                  onChange={(event) => update({ description: event.target.value })}
                />
              </Field>
            </div>
            <Field label="CLI package">
              <Input
                monospace
                aria-label="CLI package"
                value={draft.harness.packageName}
                disabled
              />
            </Field>
            <Field
              label="Exact CLI version"
              hint="Runs always materialize this pinned version."
            >
              <Input
                monospace
                aria-label="Exact CLI version"
                value={draft.harness.cliVersion}
                disabled
              />
            </Field>
            <Field label="Protocol version">
              <Input
                monospace
                aria-label="Protocol version"
                value={draft.harness.protocolVersion}
                disabled
              />
            </Field>
            <Field label="Model">
              <div className="flex flex-col gap-1">
                <Input
                  monospace
                  aria-label="Search models"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="Search models…"
                  disabled={!editable || capabilityLoading}
                />
                <Select
                  size="compact"
                  options={filteredModels.map((model) => ({
                    value: model.id,
                    label: model.name,
                    hint: model.id,
                  }))}
                  value={draft.model.id}
                  placeholder={
                    catalogModels.find(
                      (model) => model.id === draft.model.id,
                    )?.name ?? `${draft.model.id} · unavailable`
                  }
                  disabled={
                    !editable ||
                    capabilityLoading ||
                    !capabilities ||
                    capabilities.stale
                  }
                  aria-label="Model"
                  onChange={(modelId) => {
                    const model = catalogModels.find(
                      (candidate) => candidate.id === modelId,
                    );
                    if (model) selectModel(model);
                  }}
                />
                {!catalogModels.some(
                  (model) => model.id === draft.model.id,
                ) && (
                  <span className="font-body text-[10px] leading-[1.35] text-amber-700">
                    Historical selection; choose a current model before
                    publishing.
                  </span>
                )}
              </div>
            </Field>
            {draft.schemaVersion === 1 && (
              <Field
                label="Model options"
                hint="Historical v1 versions retain provider-default model options."
              >
                <Input
                  monospace
                  aria-label="Model options"
                  value={
                    Object.keys(draft.model.options).length === 0
                      ? "Provider default"
                      : "Unsupported historical options"
                  }
                  disabled
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
                {capabilities.refreshFailure && (
                  <span className="mt-1 block">
                    {capabilities.refreshFailure.message}
                  </span>
                )}
              </div>
            )}
            {draft.schemaVersion === 2 && (
              <>
                <Field label="Reasoning effort">
                  <Select
                    size="compact"
                    options={[
                      ...(draft.model.capability.defaultReasoningEffort
                        ? [
                            {
                              value: "model_default",
                              label: `Model default · ${draft.model.capability.defaultReasoningEffort}`,
                            },
                          ]
                        : []),
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
                    aria-label="Reasoning effort"
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
                  <Select
                    size="compact"
                    options={draft.model.capability.serviceTiers.map(
                      (tier) => ({
                        value: tier.id,
                        label: tier.name,
                        hint: tier.description ?? undefined,
                      }),
                    )}
                    value={draft.model.serviceTier}
                    disabled={!editable || capabilities?.stale !== false}
                    aria-label="Service tier"
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
                    <Select
                      size="compact"
                      options={draft.model.capability.verbosityOptions.map(
                        (verbosity) => ({
                          value: verbosity.id,
                          label: verbosity.name,
                          hint: verbosity.description ?? undefined,
                        }),
                      )}
                      value={draft.model.verbosity ?? ""}
                      disabled={!editable || capabilities?.stale !== false}
                      aria-label="Response verbosity"
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
                  <Input
                    monospace
                    aria-label="Context window"
                    value={
                      draft.model.capability.contextWindowTokens === null
                        ? "Not advertised"
                        : `${draft.model.capability.contextWindowTokens.toLocaleString()} tokens`
                    }
                    disabled
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
              <Textarea
                size="sm"
                monospace
                aria-label="Profile instructions"
                value={draft.instructions}
                maxLength={100_000}
                disabled={!editable}
                onChange={(event) => update({ instructions: event.target.value })}
                className="min-h-[128px]"
              />
            </Field>
            <div>
              <CheckboxField
                label="Always include repository AGENTS.md / CLAUDE.md instructions"
                checked={draft.context.includeRepositoryInstructions}
                disabled
                onChange={() => {}}
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
                <Input
                  monospace
                  aria-label="Compaction"
                  value="Provider default"
                  disabled
                />
              ) : (
                <div className="flex flex-col gap-2">
                  <Select
                    size="compact"
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
                    aria-label="Compaction"
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
                onChange={() => {}}
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
              <Input
                monospace
                aria-label="Declared maximum concurrent subagents"
                value={draft.subagents.maxConcurrent}
                disabled
              />
            </Field>
            <Field label="Max duration (ms)" hint="Blank inherits the workflow limit.">
              <Input
                monospace
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
              />
            </Field>
            <Field label="Max tokens" hint="Blank inherits the workflow limit.">
              <Input
                monospace
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
              />
            </Field>
            <Field label="Max cost (USD)" hint="Blank inherits the workflow limit.">
              <Input
                monospace
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
              />
            </Field>
            <Field
              label="Workspace mode"
              hint="The current runtime supports managed workspaces only."
            >
              <Input
                monospace
                aria-label="Workspace mode"
                value="Managed workspace"
                disabled
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
                    onChange={() => {}}
                  />
                ))}
              </div>
            </Field>
            <Field
              label="MCP integrations"
              hint="None are available until an integration has a code-owned runtime materializer."
            >
              <Input
                monospace
                aria-label="MCP integrations"
                value="None available"
                disabled
              />
            </Field>
            <Field
              label="Credential references"
              hint="Symbolic references only. Credential values are resolved at runtime and never stored here."
            >
              <Input
                monospace
                aria-label="Credential references"
                value={
                  draft.harness.provider === "claude" ? "anthropic" : "openai"
                }
                disabled
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
              const source = skillSource(skill.artifactHash);
              const local =
                source !== undefined && !isGitHubSkillSource(source);
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
                      {source && (
                        <div className="mt-1 font-mono text-[9px] text-neutral-500">
                          {skillSourceLabel(source)}
                          {artifact ? ` · ${artifact.files.length} files` : ""}
                        </div>
                      )}
                      <LocalSkillPinNotice
                        artifactHash={skill.artifactHash}
                        source={source}
                        discovery={deploymentSkills}
                      />
                      {refreshNotice?.artifactHash === skill.artifactHash && (
                        <div
                          className={`mt-1 font-body text-[10px] ${
                            refreshNotice.changed
                              ? "text-green-700"
                              : "text-neutral-600"
                          }`}
                        >
                          {refreshNotice.changed
                            ? "Refreshed: updated to new contents."
                            : local
                              ? "Refreshed: this deployment carries the same contents, so the pin is unchanged."
                              : "Refreshed: the default branch carries the same contents, so the pin is unchanged."}
                        </div>
                      )}
                    </div>
                    {editable && (
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => void onRefreshSkill(skill.artifactHash)}
                          disabled={busy !== null || dirty}
                          title={
                            dirty
                              ? "Save local profile changes before refreshing a skill"
                              : local
                                ? "Re-read this skill from the deployment and update only this profile draft"
                                : "Discover the latest commit and update only this profile draft"
                          }
                        >
                          {busy === `refresh-${skill.artifactHash}`
                            ? "Refreshing…"
                            : "Refresh"}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
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
                        >
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {editable && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => setShowSkillImport(true)}
                disabled={busy !== null}
              >
                Add skills
              </Button>
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
            <Textarea
              monospace
              invalid={homeFilesError}
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
              className="min-h-[180px]"
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
                            <Button
                              variant="danger"
                              size="sm"
                              type="button"
                              onClick={() => void onRestore(version.version)}
                              disabled={busy !== null || dirty}
                            >
                              {busy === `restore-${version.version}`
                                ? "Restoring…"
                                : "Confirm restore"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              onClick={() => setConfirmRestore(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() => setConfirmRestore(version.version)}
                            disabled={busy !== null || dirty}
                            title={
                              dirty
                                ? "Save local changes before restoring a version"
                                : undefined
                            }
                          >
                            Restore to draft
                          </Button>
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
            <Button
              variant="secondary"
              type="button"
              onClick={() => void onUnarchive()}
              disabled={busy !== null}
            >
              {busy === "unarchive" ? "Restoring…" : "Restore profile"}
            </Button>
          ) : detail.canDeleteProfile === true ? (
            confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 font-body text-[12px] text-neutral-700">
                <span>
                  Permanently delete this unused unpublished draft? This cannot
                  be undone.
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={busy !== null}
                >
                  {busy === "remove" ? "Deleting…" : "Delete profile"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="danger"
                size="sm"
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy !== null}
              >
                Delete unused draft
              </Button>
            )
          ) : confirmArchive ? (
            <div className="flex flex-wrap items-center gap-2 font-body text-[12px] text-neutral-700">
              <span>
                Archive this profile? Existing pinned workflows will keep their
                exact version.
              </span>
              <Button
                variant="danger"
                size="sm"
                type="button"
                onClick={() => void onArchive()}
                disabled={busy !== null || dirty}
              >
                {busy === "archive" ? "Archiving…" : "Confirm archive"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setConfirmArchive(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="danger"
              size="sm"
              type="button"
              onClick={() => setConfirmArchive(true)}
              disabled={busy !== null || dirty}
              title={
                dirty ? "Save local changes before archiving" : undefined
              }
            >
              Archive profile
            </Button>
          )}
        </div>
      )}

      <SkillImport
        open={showSkillImport}
        disabled={!editable || busy !== null}
        pinned={draft.skills.map((skill) => {
          const source = skillSource(skill.artifactHash);
          return {
            name: skill.name,
            artifactHash: skill.artifactHash,
            sourceLabel: source ? skillSourceLabel(source) : null,
          };
        })}
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
