"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  MemoryDocumentDto,
  PrePrCheckRepositoryConfig,
  RepositoryCatalogEntry,
  RepositoryProfileVersion,
  RepositorySuggestionRecord,
} from "@shared/contracts";
import { REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES } from "@shared/contracts";
import { REPOSITORY_RULES_VARIABLES } from "@shared/prompts";

import { apiClient } from "@/lib/api/client";
import {
  asScriptsEntry,
  durationLabel,
  formatDateTime,
  lastChangeLabel,
  repositoryLabel,
  sourceLabel,
  suggestionUsageLabel,
} from "@/lib/repository-catalog/format";
import {
  NOTHING_TO_SAVE_NOTICE,
  REASON_REQUIRED_NOTE,
  buildProfileUpsert,
  changedProfileFields,
  draftFromProfile,
  profileSaveBlocker,
  profileSaveErrorNotice,
  staleProfileNotice,
  type RepositoryProfileDraft,
  type RepositoryProfileField,
} from "@/lib/repository-catalog/profile";
import { DISCARD_UNSAVED_PROMPT, trackUnsavedSettings } from "@/lib/settings/unsaved";
import { RepositoryScriptGroupsEditor } from "@/components/cockpit/screens/repositories/script-groups";
import { PromptEditor } from "@/components/cockpit/prompt-editor/prompt-editor";

import { SuggestionPanel } from "./suggestion-panel";

/**
 * Where the rules land, said on the screen that writes them.
 *
 * Not decoration: the heading above already promises the agent gets them, and
 * the one thing an operator cannot see from here is WHICH prompts. It is the
 * harness profile's "include repository instructions" that decides, the same
 * switch that decides whether a committed AGENTS.md is read, so a profile with
 * it off gets no rules either and this sentence is the only warning of that.
 */
const RULES_DESTINATION_NOTE =
  "Appended to every agent prompt that includes repository instructions, in a section headed \"Repository rules for\" this repository, on runs that may touch it. A harness profile with repository instructions switched off gets none. Only the variables in the menu render here, and they name the run and nothing else: ticket, plan and review text never reaches rules, because a rules heading is an instruction and anybody who can file a ticket could write one. A name outside that list is left standing as you typed it.";

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
  batchTimeoutMinutes: "checks ceiling",
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
      batchTimeoutMinutes: previous.batchTimeoutMinutes,
    },
    {
      description: version.description,
      rules: version.rules,
      relationships: version.relationships,
      scriptGroups: version.scriptGroups,
      gateGroups: version.gateGroups,
      batchTimeoutMinutes: version.batchTimeoutMinutes,
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
  const [ceilingBlocker, setCeilingBlocker] = useState<string | null>(null);
  // The version this screen's baseline was read from, and the token every save
  // carries. The write itself is conditional on it, so there is no read in
  // front of the write and no window between the two.
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
    scriptsBlocker ??
    ceilingBlocker ??
    profileSaveBlocker({ changed, reason, canEdit: canManage });

  /**
   * Saving: the dirty fields, the version this screen loaded, and nothing else.
   *
   * There is no read in front of the write any more. The PUT carries
   * `expectedProfileVersion`, and the statement that mints the version selects
   * no row when the stored profile has moved, so the refusal comes from the
   * write itself rather than from a read that could go stale between the two.
   * The 409 carries the version it actually sits at, which is what the notice
   * names.
   *
   * `baseVersion` is deliberately NOT advanced on a conflict. The draft is
   * still built on the version this screen loaded, so accepting the new number
   * would arm the next click to overwrite the edit that was just refused.
   */
  async function put(next: RepositoryProfileDraft, why: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = buildProfileUpsert({
        repository,
        saved,
        draft: next,
        reason: why,
        expectedProfileVersion: baseVersion,
      });
      const result = await apiClient.repositoryCatalog.save(repository.id, body);
      if (!result.ok) {
        setError(profileSaveErrorNotice(result.errorMessage, body.scriptGroups));
        return;
      }
      if ("error" in result.data) {
        setError(staleProfileNotice(result.data.currentVersion));
        return;
      }
      const mutation = result.data;
      // The response carries the row and the version it minted, not the profile
      // itself, so the draft becomes the new baseline: it is exactly what was
      // sent, merged over what was stored.
      setSaved(structuredClone(next));
      setDraft(structuredClone(next));
      setReason("");
      if (mutation.version !== undefined) setBaseVersion(mutation.version);
      if (mutation.unchanged === true) {
        setNotice(NOTHING_TO_SAVE_NOTICE);
        return;
      }
      const moved = mutation.changedFields;
      const what =
        moved === undefined || moved.length === 0
          ? ""
          : `: ${moved.map((field) => FIELD_LABELS[field]).join(", ")}`;
      setNotice(
        mutation.version === undefined
          ? "Saved."
          : `Saved as version ${mutation.version}${what}.`,
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
            already says. Same editor as the prompt library: what is stored is
            still the markdown, and a {"{{variable}}"} is shown as one.
          </p>
          <div className="mt-2" aria-label="Rules">
            <PromptEditor
              value={draft.rules}
              disabled={!canManage}
              minHeightClass="min-h-[320px]"
              variables={REPOSITORY_RULES_VARIABLES}
              onChange={(rules) => setDraft({ ...draft, rules })}
            />
          </div>
          <p className="m-0 mt-1 font-body text-[11px] text-neutral-500">
            {RULES_DESTINATION_NOTE}
          </p>
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
          <ChecksCeilingField
            value={draft.batchTimeoutMinutes}
            disabled={!canManage}
            onBlockerChange={setCeilingBlocker}
            onChange={(batchTimeoutMinutes) =>
              setDraft({ ...draft, batchTimeoutMinutes })
            }
          />
        </section>
      )}

      {tab === "memory" && <MemoryTab memory={memory} canDelete={canManage} />}

      {tab === "history" && (
        <>
          <HistoryTab
            versions={versions}
            currentVersion={repository.profileVersion}
            onRestore={canManage && !busy ? restore : null}
          />
          <SuggestionHistory repositoryId={repository.id} />
        </>
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

      <div className="mt-3 font-body text-[12px] font-semibold text-neutral-800">
        Description
      </div>
      <div className="mt-1" aria-label="Description">
        <PromptEditor
          value={draft.description}
          disabled={disabled}
          minHeightClass="min-h-[180px]"
          onChange={(description) => onChange({ ...draft, description })}
        />
      </div>
      <p className="m-0 mt-1 font-body text-[10px] text-neutral-500">
        Markdown. The first line is what the Repositories list shows. Read by
        people, not by the agent: unlike Rules, a description reaches no prompt,
        so a {"{{variable}}"} in one is never rendered.
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

/**
 * One rule, two places it has to read correctly: under the field, where it
 * tells the reader what to type, and after "Save is disabled: " at the Save
 * bar. Both are built from the one bound the contract enforces, so widening
 * `REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES` cannot leave either sentence behind.
 */
const CHECKS_CEILING_FIELD_ERROR =
  `Enter a whole number of minutes between 1 and ` +
  `${REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES}, or leave it empty.`;

const CHECKS_CEILING_BLOCKER =
  `the checks ceiling must be a whole number of minutes between 1 and ` +
  `${REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES}, or empty`;

/**
 * The ceiling this repository asks for, beside the groups it bounds.
 *
 * Empty means "no claim": the run keeps whatever ceiling the operator
 * configuration sets, which is what every repository did before this field
 * existed. That is why blank is a value here and not a validation error.
 *
 * The typed text is held locally so a half-typed number ("1" on the way to
 * "12", or a "0" the range refuses) is not pushed into the draft. Only a value
 * the contract would accept reaches `onChange`, so the Save button is never
 * armed by something the route will refuse.
 */
function ChecksCeilingField({
  value,
  disabled,
  onBlockerChange,
  onChange,
}: {
  value: number | null;
  disabled: boolean;
  onBlockerChange?: (blocker: string | null) => void;
  onChange: (next: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);
  const trimmed = text.trim();
  const parsed = Number(trimmed);
  const invalid =
    trimmed.length > 0 &&
    !(
      Number.isInteger(parsed) &&
      parsed >= 1 &&
      parsed <= REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES
    );

  // Reported up rather than only drawn here, exactly as the groups editor
  // reports its own issue: a value the contract refuses never reaches the
  // draft, so without this the Save button stayed armed and saved the old
  // number while the screen showed the new one.
  const report = onBlockerChange;
  useEffect(() => {
    report?.(invalid ? CHECKS_CEILING_BLOCKER : null);
    // Leaving the tab unmounts this field and the typed text goes with it, so
    // the input returns showing the draft's value, which is always one the
    // contract accepts. The blocker has to leave with it or Save stays wedged
    // behind a message nothing renders any more.
    return () => report?.(null);
  }, [invalid, report]);

  return (
    <div className="mt-4 border-t border-neutral-200 pt-3">
      <label className="block font-body text-[12px] font-semibold text-neutral-800">
        Checks ceiling (minutes)
        <input
          value={text}
          disabled={disabled}
          aria-label="Checks ceiling"
          inputMode="numeric"
          placeholder="operator ceiling"
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const candidate = Number(next.trim());
            if (next.trim().length === 0) {
              onChange(null);
              return;
            }
            if (
              Number.isInteger(candidate) &&
              candidate >= 1 &&
              candidate <= REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES
            ) {
              onChange(candidate);
            }
          }}
          className="mt-1 block w-[160px] rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px]"
        />
      </label>
      <p className="m-0 mt-1 font-body text-[11px] text-neutral-500">
        How long the whole batch of checks may run for this repository. Leave it
        empty to keep the operator ceiling. A run that touches several
        repositories takes the highest claim among them, because the ceiling
        bounds the run and not one repository&apos;s share of it.
      </p>
      {invalid && (
        <p role="status" className="m-0 mt-1 font-body text-[11px] text-red-600">
          {CHECKS_CEILING_FIELD_ERROR}
        </p>
      )}
    </div>
  );
}

const OUTCOME_LABELS: Record<RepositorySuggestionRecord["outcome"], string> = {
  proposed: "proposed",
  timeout: "timed out",
  malformed: "malformed answer",
  failed: "failed",
  missing: "repository missing at the provider",
};

/**
 * Every suggestion call this repository has spent, newest first.
 *
 * Under the profile versions rather than beside them, because they answer the
 * same question from two sides: the versions say what changed, this says what
 * was paid to propose changes. A call that reported no tokens is **unpriced**
 * and says so; printing a zero there would say a timed-out call was free.
 *
 * Cursor paginated. The rows are append-only, so an offset page would shift
 * under a reader the moment somebody asks for another suggestion.
 */
function SuggestionHistory({ repositoryId }: { repositoryId: number }) {
  const [rows, setRows] = useState<RepositorySuggestionRecord[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setRows(null);
    setCursor(null);
    setError(null);
    void apiClient.repositoryCatalog
      .suggestions(repositoryId)
      .then((result) => {
        if (!live) return;
        if (!result.ok) {
          setError(result.errorMessage);
          return;
        }
        setRows(result.data.suggestions);
        setCursor(result.data.nextCursor);
      })
      .catch(() => {
        if (live) setError("Could not reach the server.");
      });
    return () => {
      live = false;
    };
  }, [repositoryId]);

  async function more() {
    if (cursor === null) return;
    setBusy(true);
    try {
      const result = await apiClient.repositoryCatalog.suggestions(repositoryId, cursor);
      if (!result.ok) {
        setError(result.errorMessage);
        return;
      }
      setRows((prev) => [...(prev ?? []), ...result.data.suggestions]);
      setCursor(result.data.nextCursor);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <h3 className="m-0 font-display text-[15px] font-medium text-coal">
        Suggestion calls
      </h3>
      <p className="m-0 mt-1 font-body text-[11px] text-neutral-500">
        Every call to the model for this repository, whether or not it proposed
        anything. A call the provider never reported usage for is unpriced, not
        free.
      </p>
      {error && (
        <p className="m-0 mt-2 font-body text-[12px] text-red-600">{error}</p>
      )}
      {rows === null && error === null && (
        <p className="m-0 mt-2 font-body text-[12px] text-neutral-500">Loading…</p>
      )}
      {rows !== null && rows.length === 0 && (
        <p className="m-0 mt-2 font-body text-[12px] text-neutral-500">
          No suggestion has been asked for on this repository.
        </p>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="list-none m-0 mt-2 p-0">
          {rows.map((row) => (
            <li
              key={row.id}
              className="border-b border-neutral-100 py-2 last:border-b-0"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-body text-[12px] text-neutral-900">
                  {OUTCOME_LABELS[row.outcome] ?? row.outcome}
                </span>
                <span className="font-body text-[12px] text-neutral-400">
                  {formatDateTime(row.createdAt)}
                </span>
                <span className="font-body text-[12px] text-neutral-700">
                  {row.actorLabel}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
                  {row.model}
                </span>
              </div>
              <div className="font-body text-[12px] text-neutral-600">
                {suggestionUsageLabel(row)} · {durationLabel(row.durationMs)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor !== null && (
        <button
          onClick={more}
          disabled={busy}
          className="mt-2 appearance-none rounded-[3px] border border-neutral-300 bg-white px-2 py-[5px] font-body text-[12px] cursor-pointer disabled:opacity-40 disabled:cursor-default"
        >
          {busy ? "Loading…" : "Show older calls"}
        </button>
      )}
    </section>
  );
}
