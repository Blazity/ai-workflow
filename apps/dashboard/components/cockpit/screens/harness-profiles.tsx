"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { ProfileEditor, type ProfileAction } from "@/components/cockpit/harness-profiles/profile-editor";
import { Button, Checkbox, Input, Select, Skeleton } from "@/components/ui";
import { apiClient, type ApiResult } from "@/lib/api/client";
import {
  isProfileSlug,
  newProfileDraft,
  upsertProfile,
} from "@/lib/harness-profiles/editor";
import {
  profileSelectionHref,
  resolveProfileSelection,
} from "@/lib/harness-profiles/selection";
import type {
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifest,
  HarnessProfileDto,
  HarnessProfileMutationResponse,
  HarnessProfilePublishResponse,
  HarnessProfilesResponse,
  HarnessSkillRefreshResponse,
} from "@shared/contracts";

async function fetchProfileDetail(
  profileId: string,
): Promise<HarnessProfileDetailResponse> {
  const response = await apiClient.harnessProfiles.detail(
    profileId,
    undefined,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(response.errorMessage);
  return response.data;
}

function NewProfilePanel({
  profiles,
  busy,
  onCancel,
  onCreate,
}: {
  profiles: HarnessProfileDto[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (
    slug: string,
    draft: HarnessProfileDraftManifest,
  ) => Promise<void>;
}) {
  const sources = profiles.filter((profile) => profile.archivedAt === null);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [sourceId, setSourceId] = useState("");

  function buildDraft(): HarnessProfileDraftManifest {
    const source = sources.find((profile) => profile.id === sourceId);
    const base = source
      ? structuredClone(source.draft)
      : newProfileDraft(provider);
    return {
      ...base,
      displayName: displayName.trim(),
      description: source
        ? `Forked from ${source.draft.displayName}.`
        : base.description,
    };
  }

  return (
    <div className="mb-3 rounded-[4px] border border-mariner-200 bg-panel p-4">
      <div className="mb-1 font-body text-[14px] font-semibold text-coal">
        Create harness profile
      </div>
      <p className="mt-0 mb-3 font-body text-[11px] text-neutral-600">
        Start from a built-in provider baseline or copy an existing profile
        draft. Publishing will create an immutable version.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Slug
          </span>
          <Input
            monospace
            value={slug}
            maxLength={64}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="custom-review"
          />
          {slug !== "" && !isProfileSlug(slug.trim()) && (
            <span className="font-body text-[10px] text-red-600">
              Use 1 to 64 lowercase letters, numbers, or hyphens.
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Display name
          </span>
          <Input
            monospace
            value={displayName}
            maxLength={120}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Custom review"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Start from
          </span>
          <Select
            options={[
              { value: "", label: "Provider baseline" },
              ...sources.map((profile) => ({
                value: profile.id,
                label: `${profile.draft.displayName} · current draft`,
              })),
            ]}
            value={sourceId}
            disabled={busy}
            aria-label="Profile starting point"
            onChange={setSourceId}
          />
        </div>
        {!sourceId && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
              Provider
            </span>
            <Select
              options={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude" },
              ]}
              value={provider}
              disabled={busy}
              aria-label="New profile provider"
              onChange={(value) =>
                setProvider(value === "claude" ? "claude" : "codex")
              }
            />
          </div>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          onClick={() => void onCreate(slug.trim(), buildDraft())}
          disabled={
            busy ||
            slug.trim() === "" ||
            displayName.trim() === "" ||
            !isProfileSlug(slug.trim())
          }
        >
          {busy ? "Creating…" : "Create draft"}
        </Button>
        <Button
          variant="secondary"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function HarnessProfilesScreen({
  initial,
  available,
}: {
  initial: HarnessProfilesResponse;
  available: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedProfileId = searchParams.get("profile");
  const [profiles, setProfiles] = useState(initial.profiles);
  const [activeId, setActiveId] = useState<string | null>(() =>
    resolveProfileSelection(initial.profiles, requestedProfileId),
  );
  const [detail, setDetail] =
    useState<HarnessProfileDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<ProfileAction | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  // Keyed by the hash the draft pins after the refresh, which is the previous
  // one when the deployment carried the same bytes.
  const [refreshNotice, setRefreshNotice] = useState<{
    artifactHash: string;
    changed: boolean;
  } | null>(null);
  const requestId = useRef(0);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  function updateProfileUrl(
    profileId: string | null,
    mode: "push" | "replace",
  ) {
    const href = profileSelectionHref(
      pathname,
      searchParams.toString(),
      profileId,
    );
    router[mode](href, { scroll: false });
  }

  function activateProfile(
    profileId: string | null,
    mode: "push" | "replace",
  ) {
    setEditorDirty(false);
    setActiveId(profileId);
    setError(null);
    setRefreshNotice(null);
    updateProfileUrl(profileId, mode);
  }

  useEffect(() => {
    const nextId = resolveProfileSelection(profiles, requestedProfileId);
    if (nextId === activeIdRef.current) {
      if (requestedProfileId !== nextId) updateProfileUrl(nextId, "replace");
      return;
    }
    if (busy !== null) {
      updateProfileUrl(activeIdRef.current, "replace");
      return;
    }
    if (
      editorDirty &&
      !window.confirm("Discard unsaved Harness Profile changes?")
    ) {
      updateProfileUrl(activeIdRef.current, "replace");
      return;
    }
    activateProfile(nextId, "replace");
  }, [requestedProfileId]);

  useEffect(() => {
    const id = ++requestId.current;
    if (!activeId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    setError(null);
    void fetchProfileDetail(activeId)
      .then((next) => {
        if (id !== requestId.current) return;
        setDetail(next);
        setProfiles((current) => upsertProfile(current, next.profile));
      })
      .catch((cause) => {
        if (id !== requestId.current) return;
        setDetail(null);
        setError(
          cause instanceof Error ? cause.message : "Unable to load profile",
        );
      })
      .finally(() => {
        if (id === requestId.current) setDetailLoading(false);
      });
  }, [activeId]);

  const visibleProfiles = useMemo(
    () =>
      profiles
        .filter((profile) => showArchived || profile.archivedAt === null)
        .filter((profile) => {
          const query = search.trim().toLowerCase();
          return (
            query === "" ||
            profile.draft.displayName.toLowerCase().includes(query) ||
            profile.slug.toLowerCase().includes(query) ||
            profile.draft.model.id.toLowerCase().includes(query)
          );
        })
        .sort((left, right) => {
          if (left.system !== right.system) return left.system ? -1 : 1;
          return left.draft.displayName.localeCompare(right.draft.displayName);
        }),
    [profiles, search, showArchived],
  );

  function confirmDiscard(): boolean {
    return (
      !editorDirty ||
      window.confirm("Discard unsaved Harness Profile changes?")
    );
  }

  function selectProfile(profileId: string | null): boolean {
    if (profileId === activeId) return true;
    if (busy !== null) return false;
    if (!confirmDiscard()) return false;
    activateProfile(profileId, "push");
    return true;
  }

  async function send<T>(
    request: () => Promise<ApiResult<T>>,
    action: typeof busy,
  ): Promise<T | null> {
    setBusy(action);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(response.errorMessage);
        return null;
      }
      return response.data;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function reload(profileId: string) {
    try {
      const next = await fetchProfileDetail(profileId);
      setProfiles((current) => upsertProfile(current, next.profile));
      if (activeIdRef.current === profileId) setDetail(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to reload profile",
      );
    }
  }

  async function saveDraft(draft: HarnessProfileDraftManifest) {
    if (!detail) return;
    setBusy("save");
    setError(null);
    try {
      const response = await apiClient.harnessProfiles.updateDraft(
        detail.profile.id,
        {
          expectedRevision: detail.profile.draftRevision,
          draft,
        },
      );
      if (!response.ok) {
        setError(response.errorMessage);
        return;
      }
      const result = response.data;
      setProfiles((current) => upsertProfile(current, result.profile));
      await reload(result.profile.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save profile");
    } finally {
      setBusy(null);
    }
  }

  async function createProfile(
    slug: string,
    draft: HarnessProfileDraftManifest,
  ) {
    if (!confirmDiscard()) return;
    setBusy("create");
    setError(null);
    try {
      const response = await apiClient.harnessProfiles.create(slug, draft);
      if (!response.ok) {
        setError(response.errorMessage);
        return;
      }
      const result = response.data;
      setProfiles((current) => upsertProfile(current, result.profile));
      setShowCreate(false);
      activateProfile(result.profile.id, "push");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to create profile",
      );
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!detail) return;
    const result = await send<HarnessProfilePublishResponse>(
      () => apiClient.harnessProfiles.publish(
        detail.profile.id,
        detail.profile.draftRevision,
      ),
      "publish",
    );
    if (result) await reload(result.profile.id);
  }

  async function fork(slug: string) {
    if (!detail) return;
    const result = await send<HarnessProfileMutationResponse>(
      () => apiClient.harnessProfiles.fork(
        detail.profile.id,
        slug,
        detail.profile.draftRevision,
      ),
      "fork",
    );
    if (result) {
      setProfiles((current) => upsertProfile(current, result.profile));
      activateProfile(result.profile.id, "push");
    }
  }

  async function restore(version: number) {
    if (!detail) return;
    const result = await send<HarnessProfileMutationResponse>(
      () => apiClient.harnessProfiles.restore(
        detail.profile.id,
        version,
        detail.profile.draftRevision,
      ),
      `restore-${version}`,
    );
    if (result) await reload(result.profile.id);
  }

  async function archive() {
    if (!detail) return;
    const result = await send<HarnessProfileMutationResponse>(
      () => apiClient.harnessProfiles.archive(
        detail.profile.id,
        detail.profile.draftRevision,
      ),
      "archive",
    );
    if (result) {
      setProfiles((current) => upsertProfile(current, result.profile));
      setShowArchived(true);
      await reload(result.profile.id);
    }
  }

  async function unarchive() {
    if (!detail) return;
    const result = await send<HarnessProfileMutationResponse>(
      () => apiClient.harnessProfiles.unarchive(
        detail.profile.id,
        detail.profile.draftRevision,
      ),
      "unarchive",
    );
    if (result) await reload(result.profile.id);
  }

  async function remove() {
    if (!detail) return;
    const removedId = detail.profile.id;
    const result = await send<{ deleted: true }>(
      () => apiClient.harnessProfiles.remove(
        removedId,
        detail.profile.draftRevision,
      ),
      "remove",
    );
    if (!result) return;
    const remaining = profiles.filter((profile) => profile.id !== removedId);
    const nextId = resolveProfileSelection(remaining, null);
    setProfiles(remaining);
    setDetail(null);
    activateProfile(nextId, "replace");
  }

  async function refreshSkill(artifactHash: string) {
    if (!detail) return;
    const result = await send<HarnessSkillRefreshResponse>(
      () => apiClient.harnessProfiles.refreshSkill(
        detail.profile.id,
        detail.profile.draftRevision,
        artifactHash,
      ),
      `refresh-${artifactHash}`,
    );
    if (!result) return;
    setRefreshNotice({
      artifactHash: result.artifact.artifactHash,
      changed: result.changed,
    });
    await reload(result.profile.id);
  }

  if (!available) {
    return (
      <div className="p-6">
        <div className="max-w-[680px] rounded-[4px] border border-red-300 bg-red-50 px-4 py-3">
          <h1 className="m-0 font-body text-[16px] font-semibold text-red-800">
            Harness profiles are unavailable
          </h1>
          <p className="mt-1 mb-0 font-body text-[12px] text-red-700">
            The dashboard could not load the organization profile catalog. Try
            again after the worker is reachable.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-8 pt-5 lg:px-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-2xl font-semibold text-coal">
            Harness profiles
          </h1>
          <p className="mt-1 mb-0 max-w-[740px] font-body text-[12px] leading-[1.5] text-neutral-600">
            Version the complete agent environment: provider, model, CLI,
            instructions, safe files, context, skills, tools, limits, and
            subagent behavior. Workflows pin an exact published version.
          </p>
        </div>
        {initial.canManageProfiles && (
          <Button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={busy !== null || showCreate}
          >
            New profile
          </Button>
        )}
      </div>

      {!initial.canManageProfiles && (
        <div className="mb-3 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          You can view profiles and select their published versions in
          workflows. Owners and admins manage profile drafts and versions.
        </div>
      )}

      {showCreate && initial.canManageProfiles && (
        <NewProfilePanel
          profiles={profiles}
          busy={busy === "create"}
          onCancel={() => setShowCreate(false)}
          onCreate={createProfile}
        />
      )}

      <div className="mb-5 flex flex-col gap-3 border-y border-neutral-200 bg-panel px-3 py-3 md:flex-row md:items-center">
        <div className="min-w-[260px] md:max-w-[360px] md:flex-1">
          <Select
            options={visibleProfiles.map((profile) => ({
              value: profile.id,
              label: `${profile.draft.displayName} · ${
                profile.archivedAt
                  ? "archived"
                  : profile.publishedVersion
                    ? `v${profile.publishedVersion}`
                    : "draft"
              }`,
            }))}
            value={
              visibleProfiles.some((profile) => profile.id === activeId)
                ? (activeId ?? "")
                : ""
            }
            disabled={busy !== null || visibleProfiles.length === 0}
            aria-label="Selected harness profile"
            onChange={(value) => selectProfile(value)}
          />
        </div>
        <Input
          aria-label="Search harness profiles"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search profiles…"
          className="min-w-[220px] md:ml-auto"
        />
        <Checkbox
          checked={showArchived}
          onChange={(event) => {
            const checked = event.target.checked;
            if (
              !checked &&
              profiles.find((profile) => profile.id === activeId)?.archivedAt
            ) {
              const switched = selectProfile(
                profiles.find((profile) => profile.archivedAt === null)?.id ??
                  null,
              );
              if (!switched) return;
            }
            setShowArchived(checked);
          }}
          className="whitespace-nowrap text-[11px] text-neutral-600"
          label="Show archived"
        />
      </div>

      <main className="min-w-0">
          {detailLoading && !detail ? (
            <div className="rounded-sm border border-neutral-200 bg-panel p-4">
              <Skeleton height={88} />
            </div>
          ) : detail ? (
            <ProfileEditor
              key={detail.profile.id}
              detail={detail}
              canManageProfiles={initial.canManageProfiles}
              busy={busy === "create" ? null : busy}
              error={error}
              onSave={saveDraft}
              onPublish={publish}
              onFork={fork}
              onArchive={archive}
              onUnarchive={unarchive}
              onDelete={remove}
              onRestore={restore}
              onRefreshSkill={refreshSkill}
              refreshNotice={refreshNotice}
              onDirtyChange={setEditorDirty}
            />
          ) : (
            <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-12 text-center font-body text-[12px] text-neutral-500">
              {error ?? "Select a harness profile."}
            </div>
          )}
      </main>
    </div>
  );
}
