"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { CkChip } from "@/components/ui";
import { Listbox } from "@/components/cockpit/listbox";
import { ProfileEditor, type ProfileAction } from "@/components/cockpit/harness-profiles/profile-editor";
import { readErrorMessage } from "@/lib/api/error-message";
import {
  isProfileSlug,
  newProfileDraft,
  upsertProfile,
} from "@/lib/harness-profiles/editor";
import type {
  HarnessProfileDetailResponse,
  HarnessProfileDraftManifestV1,
  HarnessProfileDto,
  HarnessProfileMutationResponse,
  HarnessProfilePublishResponse,
  HarnessProfilesResponse,
  HarnessSkillRefreshResponse,
} from "@shared/contracts";

const primaryButtonClass =
  "appearance-none rounded-[3px] border border-mariner bg-mariner px-3.5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-white cursor-pointer disabled:cursor-default disabled:opacity-40";
const secondaryButtonClass =
  "appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3.5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal cursor-pointer disabled:cursor-default disabled:opacity-40";

async function fetchProfileDetail(
  profileId: string,
): Promise<HarnessProfileDetailResponse> {
  const response = await fetch(
    `/api/harness-profiles/${encodeURIComponent(profileId)}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return response.json() as Promise<HarnessProfileDetailResponse>;
}

function ProfileRailRow({
  profile,
  active,
  onSelect,
}: {
  profile: HarnessProfileDto;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={`appearance-none w-full border-none border-b border-neutral-100 px-3 py-3 text-left cursor-pointer transition-colors ${
        active ? "bg-mariner-100" : "bg-transparent hover:bg-app-bg"
      } ${profile.archivedAt ? "opacity-60" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={`font-body text-[13px] font-semibold ${
            active ? "text-mariner" : "text-coal"
          }`}
        >
          {profile.draft.displayName}
        </span>
        {profile.system ? (
          <CkChip tone="mariner">System</CkChip>
        ) : profile.archivedAt ? (
          <CkChip tone="blocked">Archived</CkChip>
        ) : profile.publishedVersion === null ? (
          <CkChip>Draft</CkChip>
        ) : (
          <CkChip tone="success">v{profile.publishedVersion}</CkChip>
        )}
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-neutral-500">
        {profile.slug}
      </div>
      <div className="mt-1 truncate font-body text-[10px] text-neutral-500">
        {profile.draft.harness.provider} · {profile.draft.model.id}
      </div>
    </button>
  );
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
    draft: HarnessProfileDraftManifestV1,
  ) => Promise<void>;
}) {
  const sources = profiles.filter((profile) => profile.archivedAt === null);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [sourceId, setSourceId] = useState("");

  function buildDraft(): HarnessProfileDraftManifestV1 {
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
          <input
            value={slug}
            maxLength={64}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="custom-review"
            className="h-[30px] rounded-[3px] border border-neutral-200 bg-white px-2 font-mono text-[11px] outline-none"
          />
          {slug !== "" && !isProfileSlug(slug.trim()) && (
            <span className="font-body text-[10px] text-red-600">
              Use 1–64 lowercase letters, numbers, or hyphens.
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Display name
          </span>
          <input
            value={displayName}
            maxLength={120}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Custom review"
            className="h-[30px] rounded-[3px] border border-neutral-200 bg-white px-2 font-mono text-[11px] outline-none"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Start from
          </span>
          <Listbox
            options={[
              { value: "", label: "Provider baseline" },
              ...sources.map((profile) => ({
                value: profile.id,
                label: `${profile.draft.displayName} · current draft`,
              })),
            ]}
            value={sourceId}
            disabled={busy}
            ariaLabel="Profile starting point"
            onChange={setSourceId}
          />
        </div>
        {!sourceId && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
              Provider
            </span>
            <Listbox
              options={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude" },
              ]}
              value={provider}
              disabled={busy}
              ariaLabel="New profile provider"
              onChange={(value) =>
                setProvider(value === "claude" ? "claude" : "codex")
              }
            />
          </div>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void onCreate(slug.trim(), buildDraft())}
          disabled={
            busy ||
            slug.trim() === "" ||
            displayName.trim() === "" ||
            !isProfileSlug(slug.trim())
          }
          className={primaryButtonClass}
        >
          {busy ? "Creating…" : "Create draft"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={secondaryButtonClass}
        >
          Cancel
        </button>
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
  const [profiles, setProfiles] = useState(initial.profiles);
  const [activeId, setActiveId] = useState<string | null>(
    initial.profiles.find((profile) => !profile.archivedAt)?.id ??
      initial.profiles[0]?.id ??
      null,
  );
  const [detail, setDetail] =
    useState<HarnessProfileDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<ProfileAction | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const requestId = useRef(0);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

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
        .sort((left, right) => {
          if (left.system !== right.system) return left.system ? -1 : 1;
          return left.draft.displayName.localeCompare(right.draft.displayName);
        }),
    [profiles, showArchived],
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
    setEditorDirty(false);
    setActiveId(profileId);
    setError(null);
    return true;
  }

  async function send<T>(
    path: string,
    body: unknown,
    action: typeof busy,
  ): Promise<T | null> {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return null;
      }
      return (await response.json()) as T;
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

  async function saveDraft(draft: HarnessProfileDraftManifestV1) {
    if (!detail) return;
    setBusy("save");
    setError(null);
    try {
      const response = await fetch(
        `/api/harness-profiles/${encodeURIComponent(detail.profile.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: detail.profile.draftRevision,
            draft,
          }),
        },
      );
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const result = (await response.json()) as HarnessProfileMutationResponse;
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
    draft: HarnessProfileDraftManifestV1,
  ) {
    if (!confirmDiscard()) return;
    setBusy("create");
    setError(null);
    try {
      const response = await fetch("/api/harness-profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, draft }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const result = (await response.json()) as HarnessProfileMutationResponse;
      setProfiles((current) => upsertProfile(current, result.profile));
      setShowCreate(false);
      setActiveId(result.profile.id);
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
      `/api/harness-profiles/${encodeURIComponent(detail.profile.id)}/publish`,
      { expectedRevision: detail.profile.draftRevision },
      "publish",
    );
    if (result) await reload(result.profile.id);
  }

  async function fork(slug: string) {
    if (!detail) return;
    const result = await send<HarnessProfileMutationResponse>(
      `/api/harness-profiles/${encodeURIComponent(detail.profile.id)}/fork`,
      {
        slug,
        expectedRevision: detail.profile.draftRevision,
      },
      "fork",
    );
    if (result) {
      setProfiles((current) => upsertProfile(current, result.profile));
      setActiveId(result.profile.id);
    }
  }

  async function restore(version: number) {
    if (!detail) return;
    const result = await send<HarnessProfileMutationResponse>(
      `/api/harness-profiles/${encodeURIComponent(detail.profile.id)}/restore`,
      { version, expectedRevision: detail.profile.draftRevision },
      `restore-${version}`,
    );
    if (result) await reload(result.profile.id);
  }

  async function archive() {
    if (!detail) return;
    const result = await send<HarnessProfileMutationResponse>(
      `/api/harness-profiles/${encodeURIComponent(detail.profile.id)}/archive`,
      { expectedRevision: detail.profile.draftRevision },
      "archive",
    );
    if (result) {
      setProfiles((current) => upsertProfile(current, result.profile));
      setShowArchived(true);
      await reload(result.profile.id);
    }
  }

  async function refreshSkill(artifactHash: string) {
    if (!detail) return;
    const result = await send<HarnessSkillRefreshResponse>(
      `/api/harness-profiles/${encodeURIComponent(detail.profile.id)}/skills/refresh`,
      {
        expectedRevision: detail.profile.draftRevision,
        artifactHash,
      },
      `refresh-${artifactHash}`,
    );
    if (result) await reload(result.profile.id);
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
          <h1 className="m-0 font-display text-[26px] font-semibold text-coal">
            Harness profiles
          </h1>
          <p className="mt-1 mb-0 max-w-[740px] font-body text-[12px] leading-[1.5] text-neutral-600">
            Version the complete agent environment: provider, model, CLI,
            instructions, safe files, context, skills, tools, limits, and
            subagent behavior. Workflows pin an exact published version.
          </p>
        </div>
        {initial.canManageProfiles && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={busy !== null || showCreate}
            className={primaryButtonClass}
          >
            New profile
          </button>
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

      <div className="flex min-h-[720px] flex-col gap-3 lg:grid lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="self-start overflow-hidden rounded-[4px] border border-neutral-200 bg-panel lg:sticky lg:top-4">
          <div className="border-b border-neutral-200 p-3">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-700">
              Organization catalog
            </div>
            <label className="mt-2 flex items-center gap-2 font-body text-[11px] text-neutral-600">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => {
                  const checked = event.target.checked;
                  if (
                    !checked &&
                    profiles.find((profile) => profile.id === activeId)
                      ?.archivedAt
                  ) {
                    const switched = selectProfile(
                      profiles.find((profile) => profile.archivedAt === null)
                        ?.id ?? null,
                    );
                    if (!switched) return;
                  }
                  setShowArchived(checked);
                }}
                className="size-3.5 accent-mariner"
              />
              Show archived profiles
            </label>
          </div>
          {visibleProfiles.length === 0 ? (
            <div className="px-3 py-8 text-center font-body text-[12px] text-neutral-500">
              No profiles to show.
            </div>
          ) : (
            visibleProfiles.map((profile) => (
              <ProfileRailRow
                key={profile.id}
                profile={profile}
                active={profile.id === activeId}
                onSelect={() => selectProfile(profile.id)}
              />
            ))
          )}
        </aside>

        <main className="min-w-0">
          {detailLoading && !detail ? (
            <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-12 text-center font-body text-[12px] text-neutral-500">
              Loading profile…
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
              onRestore={restore}
              onRefreshSkill={refreshSkill}
              onDirtyChange={setEditorDirty}
            />
          ) : (
            <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-12 text-center font-body text-[12px] text-neutral-500">
              {error ?? "Select a harness profile."}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
