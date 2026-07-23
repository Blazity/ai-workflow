"use client";

import { useEffect, useMemo, useState } from "react";

import { CkCard, CkChip } from "@/components/ui";
import { Listbox } from "@/components/cockpit/listbox";
import { SkillImport } from "./skill-import";
import {
  canEditProfile,
  isProfileSlug,
  withHarnessProvider,
} from "@/lib/harness-profiles/editor";
import type {
  HarnessProvider,
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifestV1,
  HarnessProfileDto,
  HarnessProfileSkillReference,
  HarnessSkillArtifact,
} from "@shared/contracts";
import { HARNESS_TOOL_IDS } from "@shared/contracts";

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
  | `restore-${number}`
  | `refresh-${string}`;

export interface ProfileEditorProps {
  detail: HarnessProfileDetailResponse;
  canManageProfiles: boolean;
  busy: ProfileAction | null;
  error: string | null;
  onSave: (draft: HarnessProfileDraftManifestV1) => Promise<void>;
  onPublish: () => Promise<void>;
  onFork: (slug: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore: (version: number) => Promise<void>;
  onRefreshSkill: (artifactHash: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
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
  onRestore,
  onRefreshSkill,
  onDirtyChange,
}: ProfileEditorProps) {
  const profile = detail.profile;
  const [draft, setDraft] = useState<HarnessProfileDraftManifestV1>(() =>
    structuredClone(profile.draft),
  );
  const [homeFilesSource, setHomeFilesSource] = useState(() =>
    JSON.stringify(profile.draft.homeFiles, null, 2),
  );
  const [homeFilesError, setHomeFilesError] = useState(false);
  const [forkSlug, setForkSlug] = useState("");
  const [showFork, setShowFork] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [importedArtifacts, setImportedArtifacts] = useState<
    Map<string, HarnessSkillArtifact>
  >(new Map());

  useEffect(() => {
    setDraft(structuredClone(profile.draft));
    setHomeFilesSource(JSON.stringify(profile.draft.homeFiles, null, 2));
    setHomeFilesError(false);
    setConfirmArchive(false);
    setConfirmRestore(null);
    setImportedArtifacts(new Map());
  }, [profile.id, profile.draftRevision, profile.draft]);

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
    Object.keys(draft.model.options).length === 0 &&
    draft.context.includeRepositoryInstructions &&
    draft.compaction.mode === "provider_default" &&
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

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const status = useMemo(() => {
    if (profile.system || profile.readOnly) return "System";
    if (profile.archivedAt) return "Archived";
    if (profile.publishedVersion === null) return "Draft only";
    return `Published v${profile.publishedVersion}`;
  }, [profile]);

  function update(next: Partial<HarnessProfileDraftManifestV1>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="m-0 font-display text-[22px] font-semibold text-coal">
              {profile.draft.displayName}
            </h1>
            <CkChip
              tone={
                profile.archivedAt
                  ? "blocked"
                  : profile.system
                    ? "mariner"
                    : "neutral"
              }
            >
              {status}
            </CkChip>
          </div>
          <div className="mt-1 font-mono text-[10px] text-neutral-500">
            {profile.slug} · draft revision {profile.draftRevision}
            {profile.draftRestoredFromVersion !== null &&
              ` · restored from v${profile.draftRestoredFromVersion}`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManageProfiles && (
            <button
              type="button"
              onClick={() => setShowFork((visible) => !visible)}
              disabled={busy !== null || dirty}
              title={
                dirty ? "Save local changes before forking the profile" : undefined
              }
              className={secondaryButtonClass}
            >
              Fork
            </button>
          )}
          {editable && (
            <>
              <button
                type="button"
                onClick={() => void onPublish()}
                disabled={
                  busy !== null ||
                  dirty ||
                  (profile.publishedVersion === null && !valid)
                }
                title={dirty ? "Save the draft before publishing" : undefined}
                className={secondaryButtonClass}
              >
                {busy === "publish" ? "Publishing…" : "Publish"}
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
        </div>
      </div>

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

      <div className="grid gap-3 xl:grid-cols-2">
        <CkCard title="Identity and harness" eyebrow="Profile draft">
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
                disabled={!editable}
                ariaLabel="Harness provider"
                onChange={(providerValue) => {
                  const provider =
                    providerValue === "claude" ? "claude" : "codex";
                  setDraft((current) => {
                    const next = withHarnessProvider(current, provider);
                    setHomeFilesSource(
                      JSON.stringify(next.homeFiles, null, 2),
                    );
                    setHomeFilesError(false);
                    return next;
                  });
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
              <input
                aria-label="Model"
                value={draft.model.id}
                maxLength={200}
                disabled={!editable}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    model: { ...current.model, id: event.target.value },
                  }))
                }
                className={inputClass}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Model options"
                hint="No configurable model options are supported by the current code-owned runtime catalog."
              >
                <input
                  aria-label="Model options"
                  value="Provider default"
                  disabled
                  className={inputClass}
                />
              </Field>
            </div>
          </div>
        </CkCard>

        <CkCard title="Instructions and context" eyebrow="Effective prompt">
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
              hint="Fixed until a provider adapter can enforce another mode."
            >
              <input
                aria-label="Compaction"
                value="Provider default"
                disabled
                className={inputClass}
              />
            </Field>
          </div>
        </CkCard>

        <CkCard title="Limits and workspace" eyebrow="Runtime behavior">
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

        <CkCard title="Tools and integrations" eyebrow="Declared capabilities">
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

        <CkCard title="Skills" eyebrow="Immutable artifacts">
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
              <SkillImport
                disabled={busy !== null}
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
                }}
              />
            )}
          </div>
        </CkCard>

        <CkCard title="Safe home files" eyebrow="Pinned runtime files">
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
          className="xl:col-span-2"
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

      {editable && (
        <div className="mt-6 border-t border-neutral-200 pt-4">
          {confirmArchive ? (
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
    </div>
  );
}

export type { ProfileAction };
