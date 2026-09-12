"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  MemoryDocumentDto,
  PrePrCheckRepositoryConfig,
  RepositoryCatalogEntry,
  RepositoryProfileVersion,
} from "@shared/contracts";

import { apiClient } from "@/lib/api/client";
import {
  asScriptsEntry,
  formatDateTime,
  lastChangeLabel,
  repositoryLabel,
  sourceLabel,
} from "@/lib/repository-catalog/format";
import {
  REASON_REQUIRED_NOTE,
  buildProfileUpsert,
  changedProfileFields,
  draftFromProfile,
  profileSaveBlocker,
  profileSaveErrorNotice,
  staleProfileNotice,
  UNREADABLE_VERSION_NOTICE,
  type RepositoryProfileDraft,
  type RepositoryProfileField,
} from "@/lib/repository-catalog/profile";
import { DISCARD_UNSAVED_PROMPT, trackUnsavedSettings } from "@/lib/settings/unsaved";
import { RepositoryScriptGroupsEditor } from "@/components/cockpit/screens/repositories/script-groups";

import { SuggestionPanel } from "./suggestion-panel";

const TABS = ["overview", "rules", "scripts", "memory", "history"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  rules: "Rules",
  scripts: "Scripts",
  memory: "Memory",
  history: "History",
};

const FIELD_LABELS: Record<RepositoryProfileField, string> = {
  description: "description",
  rules: "rules",
  relationships: "relationships",
  scriptGroups: "script groups",
  gateGroups: "gate selection",
};

export interface RepositoryMemorySlot {
  subjectKey: string;
  docPath: string;
  document: MemoryDocumentDto | null;
}

/**
 * The scripts entry the editor works on.
 *
 * The profile carries the gate selection twice: inside the stored entry, where
 * the editor has always kept it, and as its own column, which is what the
 * engine's composition prefers. They are written together and read together
 * here, so the two can never disagree; splitting them would mean a gate
 * selection that saves and then does not apply.
 */
function scriptsEntryOf(draft: RepositoryProfileDraft): PrePrCheckRepositoryConfig | null {
  const entry = asScriptsEntry(draft.scriptGroups);
  if (entry === null) return null;
  return draft.gateGroups === null ? entry : { ...entry, gateGroups: draft.gateGroups };
}

function whatChanged(
  previous: RepositoryProfileVersion | undefined,
  version: RepositoryProfileVersion,
): string {
  if (previous === undefined) return "first version";
  const changed = changedProfileFields(
    {
      description: previous.description,
      rules: previous.rules,
      relationships: previous.relationships,
      scriptGroups: previous.scriptGroups,
      gateGroups: previous.gateGroups,
    },
    {
      description: version.description,
      rules: version.rules,
      relationships: version.relationships,
      scriptGroups: version.scriptGroups,
      gateGroups: version.gateGroups,
    },
  );
  return changed.length === 0
    ? "nothing this screen renders"
    : changed.map((field) => FIELD_LABELS[field]).join(", ");
}

export function RepositoryEntryScreen({
  repository,
  currentProfile,
  versions,
  catalog,
  allowedEnv,
  memory,
  canManage,
}: {
  repository: RepositoryCatalogEntry;
  currentProfile: RepositoryProfileVersion | null;
  versions: readonly RepositoryProfileVersion[];
  /** Every catalog row, so a relationship can name the repository it points at
   *  rather than showing an id. */
  catalog: readonly RepositoryCatalogEntry[];
  allowedEnv: string[] | undefined;
  memory: readonly RepositoryMemorySlot[];
  /** canManageRepositoryCatalog(role): owners and admins. */
  canManage: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const [saved, setSaved] = useState<RepositoryProfileDraft>(() =>
    draftFromProfile(currentProfile),
  );
  const [draft, setDraft] = useState<RepositoryProfileDraft>(() =>
    draftFromProfile(currentProfile),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scriptsBlocker, setScriptsBlocker] = useState<string | null>(null);
  // The version this screen's baseline was read from. The upsert has no version
  // token, so this is what the pre-flight compares the stored row against.
  const [baseVersion, setBaseVersion] = useState(repository.profileVersion);

  const changed = useMemo(() => changedProfileFields(saved, draft), [saved, draft]);
  const dirty = changed.length > 0;

  // The shell asks this set before it navigates, and the logout button asks it
  // before it ends the session. Registering per repository means two entries
  // open in two tabs cannot clear each other's flag.
  useEffect(
    () => trackUnsavedSettings(`repository:${repository.id}`, dirty),
    [repository.id, dirty],
  );

  // A closed tab loses whatever is not saved. Back and forward are not covered
  // by this event; the shell's own guard covers a router.push.
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const w = window;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    w.addEventListener("beforeunload", onBeforeUnload);
    return () => w.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const blocker =
    scriptsBlocker !== null
      ? scriptsBlocker
      : profileSaveBlocker({ changed, reason, canEdit: canManage });

  /**
   * The one thing standing between two admins and a silently lost edit.
   *
   * The upsert sends the whole merged profile and the route takes no version
   * token, so a save built on a stale baseline replaces the other edit rather
   * than merging with it. There is no way to make the write conditional from
   * here, so the row is re-read immediately before the PUT and a moved version
   * refuses the save. The window between the read and the write stays open;
   * closing it needs an `if-match` on the worker.
   *
   * A read that FAILS is its own answer, never "unmoved": treating it as a pass
   * would mean a flaky GET silently turns the guard off and lets the overwrite
   * through, which is the one outcome this function exists to prevent.
   */
  async function movedUnderUs(): Promise<
    { kind: "same" } | { kind: "moved"; version: number } | { kind: "unreadable" }
  > {
    const latest = await apiClient.repositoryCatalog.entry(repository.id, {
      cache: "no-store",
    });
    if (!latest.ok) return { kind: "unreadable" };
    const version = latest.data.repository.profileVersion;
    return version === baseVersion ? { kind: "same" } : { kind: "moved", version };
  }

  async function put(next: RepositoryProfileDraft, why: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const moved = await movedUnderUs();
      if (moved.kind === "unreadable") {
        setError(UNREADABLE_VERSION_NOTICE);
        return;
      }
      if (moved.kind === "moved") {
        setError(staleProfileNotice(moved.version));
        return;
      }
      const body = buildProfileUpsert({
        repository,
        saved,
        draft: next,
        reason: why,
      });
      const result = await apiClient.repositoryCatalog.save(repository.id, body);
      if (!result.ok) {
        setError(profileSaveErrorNotice(result.errorMessage, body.scriptGroups));
        return;
      }
      // The response carries the row and the version it minted, not the profile
      // itself, so the draft becomes the new baseline: it is exactly what was
      // sent, merged over what was stored.
      setSaved(structuredClone(next));
      setDraft(structuredClone(next));
      setReason("");
      if (result.data.version !== undefined) setBaseVersion(result.data.version);
      setNotice(
        result.data.version === undefined
          ? "Saved."
          : `Saved as version ${result.data.version}.`,
      );
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    await put(draft, reason.trim());
  }

  /** Restoring an old version is a new version, not a rewind: the same
   *  full-profile PUT, with a reason that says what it was. */
  async function restore(version: RepositoryProfileVersion) {
    await put(draftFromProfile(version), `Restore v${version.version}`);
  }

  function discard() {
    if (
      typeof window !== "undefined" &&
      typeof window.confirm === "function" &&
      !window.confirm(DISCARD_UNSAVED_PROMPT)
    ) {
      return;
    }
    setDraft(structuredClone(saved));
    setReason("");
    setError(null);
  }

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          <a href="/repositories" className="text-neutral-500 no-underline hover:underline">
            Repositories
          </a>{" "}
          / {repository.provider}
        </div>
        <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
          {repositoryLabel(repository)}
        </h2>
        <div className="flex flex-wrap items-center gap-2 font-body text-[12px] text-neutral-600">
          <span className="rounded-[3px] bg-app-bg px-[5px] py-[1px] font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-600">
            {sourceLabel(repository.source)}
          </span>
          <span>{repository.enabled ? "enabled" : "not enabled"}</span>
          <span>{lastChangeLabel(currentProfile)}</span>
        </div>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-neutral-200">
        {TABS.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? "page" : undefined}
            className={`appearance-none border-none bg-transparent px-3 py-2 font-body text-[13px] cursor-pointer ${
              tab === id
                ? "text-coal font-semibold border-b-2 border-mariner"
                : "text-neutral-600"
            }`}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </nav>

      {notice && (
        <div
          role="status"
          className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-700"
        >
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700">
          {error}
        </div>
      )}
      {!canManage && (
        <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          Read-only: everything is shown, and changing it needs the owner or
          admin role.
        </div>
      )}

      {tab === "overview" && (
        <OverviewTab
          repository={repository}
          catalog={catalog}
          draft={draft}
          disabled={!canManage}
          onChange={setDraft}
        />
      )}

      {tab === "rules" && (
        <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
          <h3 className="m-0 font-display text-[15px] font-medium text-coal">Rules</h3>
          <p className="m-0 mt-1 font-body text-[12px] text-neutral-600">
            Markdown. Handed to the agent as standing instructions for this
            repository, so write what it must and must not do, not what the code
            already says.
          </p>
          <textarea
            value={draft.rules}
            disabled={!canManage}
            aria-label="Rules"
            rows={16}
            onChange={(event) => setDraft({ ...draft, rules: event.target.value })}
            className="mt-2 w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px]"
          />
        </section>
      )}

      {tab === "scripts" && (
        <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
          <h3 className="m-0 font-display text-[15px] font-medium text-coal">
            Script groups
          </h3>
          <div className="mt-2">
            <RepositoryScriptGroupsEditor
              repository={{ provider: repository.provider, path: repository.path }}
              entry={scriptsEntryOf(draft)}
              savedEntry={scriptsEntryOf(saved)}
              allowedEnv={allowedEnv}
              disabled={!canManage}
              onBlockerChange={setScriptsBlocker}
              onChange={(next) =>
                setDraft({
                  ...draft,
                  scriptGroups: next as unknown as Record<string, unknown> | null,
                  gateGroups: next?.gateGroups ?? null,
                })
              }
            />
          </div>
        </section>
      )}

      {tab === "memory" && <MemoryTab memory={memory} canDelete={canManage} />}

      {tab === "history" && (
        <HistoryTab
          versions={versions}
          currentVersion={repository.profileVersion}
          onRestore={canManage && !busy ? restore : null}
        />
      )}

      {canManage && (tab === "overview" || tab === "rules" || tab === "scripts") && (
        <SuggestionPanel
          repositoryId={repository.id}
          repository={{ provider: repository.provider, path: repository.path }}
          currentEntry={scriptsEntryOf(draft)}
          currentDescription={draft.description}
          currentRules={draft.rules}
          onUseDescription={(description) => {
            setDraft((prev) => ({ ...prev, description }));
            setTab("overview");
          }}
          onUseRules={(rules) => {
            setDraft((prev) => ({ ...prev, rules }));
            setTab("rules");
          }}
          onAcceptGroups={(next) => {
            setDraft((prev) => ({
              ...prev,
              scriptGroups: next as unknown as Record<string, unknown>,
              gateGroups: next.gateGroups ?? null,
            }));
            setTab("scripts");
          }}
        />
      )}

      {canManage && dirty && (
        <div className="sticky bottom-0 -mx-4 lg:-mx-6 border-t border-neutral-200 bg-panel px-4 lg:px-6 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-body text-[12px] font-semibold text-neutral-900">
              Unsaved changes: {changed.map((field) => FIELD_LABELS[field]).join(", ")}
            </span>
            <label className="flex-1 min-w-[220px] font-body text-[12px] text-neutral-800">
              <span className="sr-only">Reason</span>
              <input
                value={reason}
                aria-label="Reason"
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why this change"
                className="w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-body text-[12px]"
              />
            </label>
            <span className="ml-auto flex items-center gap-2">
              <button
                onClick={discard}
                disabled={busy}
                className="appearance-none rounded-[3px] border border-neutral-300 bg-white px-3 py-[6px] font-body text-[12px] text-neutral-700 cursor-pointer hover:bg-app-bg disabled:opacity-40 disabled:cursor-default"
              >
                Discard
              </button>
              <button
                onClick={save}
                disabled={blocker !== null || busy}
                className="appearance-none border-none rounded-[3px] bg-mariner px-4 py-2 font-body text-[13px] font-semibold text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </span>
          </div>
          {blocker && (
            <p role="status" className="m-0 mt-[6px] font-body text-[11px] text-red-600">
              Save is disabled: {blocker}.
            </p>
          )}
          <p className="m-0 mt-[6px] font-body text-[10px] text-neutral-500">
            {REASON_REQUIRED_NOTE}
          </p>
        </div>
      )}
    </div>
  );
}

function OverviewTab({
  repository,
  catalog,
  draft,
  disabled,
  onChange,
}: {
  repository: RepositoryCatalogEntry;
  catalog: readonly RepositoryCatalogEntry[];
  draft: RepositoryProfileDraft;
  disabled: boolean;
  onChange: (next: RepositoryProfileDraft) => void;
}) {
  const others = catalog.filter((entry) => entry.id !== repository.id);
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");

  const nameOf = (id: number) =>
    catalog.find((entry) => entry.id === id)?.path ?? `repository ${id}`;

  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <h3 className="m-0 font-display text-[15px] font-medium text-coal">Overview</h3>

      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          Path
        </dt>
        <dd className="m-0 font-mono text-[12px] text-neutral-800">
          {repository.provider}:{repository.path}
        </dd>
        <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          Default branch
        </dt>
        <dd className="m-0 font-mono text-[12px] text-neutral-800">
          {repository.defaultBranch || "not recorded"}
        </dd>
      </dl>
      <p className="m-0 mt-1 font-body text-[10px] text-neutral-500">
        The path and the default branch come from the provider when the
        repository is imported. They are identity, not profile, so they are not
        edited here.
      </p>

      <label className="mt-3 block font-body text-[12px] font-semibold text-neutral-800">
        Description
        <textarea
          value={draft.description}
          disabled={disabled}
          aria-label="Description"
          rows={8}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
          className="mt-1 w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px]"
        />
      </label>
      <p className="m-0 mt-1 font-body text-[10px] text-neutral-500">
        Markdown. The first line is what the Repositories list shows.
      </p>

      <div className="mt-3 font-body text-[12px] font-semibold text-neutral-800">
        Relationships
      </div>
      <p className="m-0 mt-1 font-body text-[11px] text-neutral-500">
        How this repository relates to others in the catalog, in your own words
        (&quot;calls&quot;, &quot;deploys&quot;, &quot;shares the schema
        with&quot;). It points at catalog entries, so a repository the catalog
        does not hold cannot be named here.
      </p>
      {draft.relationships.length === 0 && (
        <p className="m-0 mt-1 font-body text-[12px] text-neutral-500">None recorded.</p>
      )}
      <ul className="list-none m-0 mt-1 p-0 flex flex-col gap-1">
        {draft.relationships.map((relationship, index) => (
          <li
            key={`${relationship.repositoryId}:${relationship.label}`}
            className="flex items-center gap-2 font-body text-[12px] text-neutral-700"
          >
            <span className="font-mono text-[12px] text-neutral-800">
              {nameOf(relationship.repositoryId)}
            </span>
            <span>{relationship.label}</span>
            {!disabled && (
              <button
                onClick={() =>
                  onChange({
                    ...draft,
                    relationships: draft.relationships.filter((_, i) => i !== index),
                  })
                }
                className="appearance-none border-none bg-transparent font-body text-[11px] text-neutral-500 hover:text-red-600 cursor-pointer"
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {!disabled && others.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={target}
            aria-label="Related repository"
            onChange={(event) => setTarget(event.target.value)}
            className="rounded-[3px] border border-neutral-200 bg-white px-2 py-[5px] font-mono text-[12px]"
          >
            <option value="">Choose a repository…</option>
            {others.map((entry) => (
              <option key={entry.id} value={String(entry.id)}>
                {entry.provider}:{entry.path}
              </option>
            ))}
          </select>
          <input
            value={label}
            aria-label="Relationship label"
            placeholder="calls"
            onChange={(event) => setLabel(event.target.value)}
            className="rounded-[3px] border border-neutral-200 bg-white px-2 py-[5px] font-body text-[12px]"
          />
          <button
            disabled={target === "" || label.trim().length === 0}
            onClick={() => {
              onChange({
                ...draft,
                relationships: [
                  ...draft.relationships,
                  { repositoryId: Number(target), label: label.trim() },
                ],
              });
              setTarget("");
              setLabel("");
            }}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-white px-2 py-[5px] font-body text-[12px] cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            Add
          </button>
        </div>
      )}
    </section>
  );
}

function MemoryTab({
  memory,
  canDelete,
}: {
  memory: readonly RepositoryMemorySlot[];
  canDelete: boolean;
}) {
  const [erased, setErased] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // Armed, and armed for ONE document: the Agent memory screen's own two-step,
  // for the same reason. Erasing is irreversible and the button sits under a
  // block of agent-written prose, which is exactly where a mis-click lands.
  // Holding the docPath rather than a boolean is what stops the confirmation
  // carrying from the document it was armed on to the one below it.
  const [armed, setArmed] = useState<string | null>(null);
  const [erasing, setErasing] = useState<string | null>(null);

  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <h3 className="m-0 font-display text-[15px] font-medium text-coal">Agent memory</h3>
      <p className="m-0 mt-1 font-body text-[12px] text-neutral-600">
        Two documents per repository, written by runs rather than by hand:
        `facts` is what the agent learned about this repository, `lessons` is
        what it learned from getting it wrong. Erasing one cannot be undone.
      </p>
      {error && (
        <div className="mt-2 rounded-[3px] border border-red-300 bg-red-50 px-2 py-[6px] font-body text-[12px] text-red-700">
          {error}
        </div>
      )}
      {memory.map((slot) => {
        const gone = erased.has(slot.docPath);
        return (
          <div
            key={slot.docPath}
            className="mt-2 rounded-[3px] border border-neutral-200 px-2 py-[6px]"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-[12px] text-neutral-900">{slot.docPath}</span>
              {slot.document !== null && !gone && (
                <span className="font-body text-[11px] text-neutral-500">
                  {slot.document.bytes} bytes · updated{" "}
                  {formatDateTime(slot.document.updatedAt)} · from run{" "}
                  {slot.document.sourceRunId}
                </span>
              )}
            </div>
            {gone || slot.document === null ? (
              <p className="m-0 mt-1 font-body text-[12px] text-neutral-500">
                {gone ? "Erased." : "Nothing recorded yet."}
              </p>
            ) : (
              <>
                <pre className="m-0 mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-neutral-700">
                  {slot.document.content}
                </pre>
                {canDelete && armed !== slot.docPath && (
                  <button
                    onClick={() => {
                      setError(null);
                      setArmed(slot.docPath);
                    }}
                    className="mt-1 appearance-none border-none bg-transparent px-0 font-body text-[12px] text-neutral-500 hover:text-red-600 cursor-pointer"
                  >
                    Erase {slot.docPath}
                  </button>
                )}
                {canDelete && armed === slot.docPath && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="font-body text-[12px] text-neutral-700">
                      Erase {slot.docPath} from the store? This removes the
                      stored text now. A later run can learn it again.
                    </span>
                    <button
                      disabled={erasing === slot.docPath}
                      onClick={async () => {
                        setError(null);
                        setErasing(slot.docPath);
                        try {
                          const result = await apiClient.memory.delete(
                            slot.subjectKey,
                            slot.docPath,
                          );
                          if (!result.ok) {
                            setError(result.errorMessage);
                            return;
                          }
                          setErased((prev) => new Set(prev).add(slot.docPath));
                          setArmed(null);
                        } finally {
                          setErasing(null);
                        }
                      }}
                      className="appearance-none border-none rounded-[3px] bg-red-600 px-2 py-[4px] font-body text-[12px] text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
                    >
                      {erasing === slot.docPath ? "Erasing…" : "Confirm erase"}
                    </button>
                    <button
                      disabled={erasing === slot.docPath}
                      onClick={() => setArmed(null)}
                      className="appearance-none border-none bg-transparent px-0 font-body text-[12px] text-neutral-500 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      <p className="m-0 mt-2 font-body text-[11px] text-neutral-500">
        Every subject&apos;s documents, including these, are on the{" "}
        <a href="/memory" className="text-mariner">
          Agent memory
        </a>{" "}
        page.
      </p>
    </section>
  );
}

function HistoryTab({
  versions,
  currentVersion,
  onRestore,
}: {
  versions: readonly RepositoryProfileVersion[];
  currentVersion: number;
  /** Null for a role that may not write, or while a save is in flight. */
  onRestore: ((version: RepositoryProfileVersion) => void) | null;
}) {
  if (versions.length === 0) {
    return (
      <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
        <h3 className="m-0 font-display text-[15px] font-medium text-coal">History</h3>
        <p className="m-0 mt-1 font-body text-[12px] text-neutral-500">
          No versions yet. This repository is known to the catalog and has never
          been given a profile.
        </p>
      </section>
    );
  }
  // Newest first from the worker; "what changed" compares each version with the
  // one below it, which is the version it replaced.
  const ordered = [...versions].sort((a, b) => b.version - a.version);
  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <h3 className="m-0 font-display text-[15px] font-medium text-coal">History</h3>
      {onRestore !== null && (
        <p className="m-0 mt-1 font-body text-[11px] text-neutral-500">
          Restoring mints a NEW version holding that version&apos;s profile. It
          rewinds nothing: the history below keeps every version, including the
          one you are leaving.
        </p>
      )}
      <ul className="list-none m-0 mt-2 p-0">
        {ordered.map((version, index) => (
          <li
            key={version.version}
            className="border-b border-neutral-100 py-2 last:border-b-0"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[12px] text-neutral-900">
                v{version.version}
              </span>
              {version.version === currentVersion && (
                <span className="rounded-[3px] bg-mariner px-[6px] py-[2px] font-mono text-[10px] text-white">
                  current
                </span>
              )}
              <span className="font-body text-[12px] text-neutral-700">
                {version.actorLabel}
              </span>
              <span className="font-body text-[12px] text-neutral-400">
                {formatDateTime(version.createdAt)}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
                checks v{version.checksVersion}
              </span>
            </div>
            <div className="font-body text-[12px] text-neutral-600">
              Changed: {whatChanged(ordered[index + 1], version)}
            </div>
            <div className="font-body text-[12px] text-neutral-700">
              {version.reason.trim().length === 0
                ? "No reason recorded."
                : version.reason}
            </div>
            {onRestore !== null && version.version !== currentVersion && (
              <button
                onClick={() => onRestore(version)}
                className="mt-1 appearance-none border-none bg-transparent px-0 font-body text-[12px] text-mariner cursor-pointer"
              >
                Restore this version
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
