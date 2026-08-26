"use client";

import React, { useEffect, useId, useState } from "react";
import { findExtendsCycle } from "@shared/contracts";
import type {
  PrePrCheckConfig,
  PrePrCheckConfigVersion,
  PrePrCheckGroupConfig,
  PrePrCheckRepositoryConfig,
  PrePrChecksResponse,
  PrePrCheckSaveResponse,
  RepositoriesResponse,
  RepositoryOption,
  RepositoryProviderStatus,
} from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";
import { Listbox } from "@/components/cockpit/listbox";

/** Shared wording between GateGroupsEditor (after the fact) and the group
 *  delete site (before the fact), so a user sees the exact same phrase. */
const GATING_ALL_GROUPS_NOTE = "Now gating on all groups.";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const GROUP_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const GROUP_NAME_MAX_LENGTH = 40;
/** The rule in one clause, for the Save blocker. The in-card line spells the
 *  same rule out longhand, where there is room for it. */
const GROUP_NAME_RULE = `lowercase letters, digits and dashes, starting with a letter, at most ${GROUP_NAME_MAX_LENGTH} characters`;

// Commands that provision a toolchain belong in Setup, which runs once and is
// never subject to a group's pass/fail gate. This only warns: a repository
// with an install step wired into a group still saves and still runs fine.
// Anchored at the start of a command segment, never matched mid-line: an
// install phrase inside a message ("yarn install was not run") is prose, not
// a command, and warning about it is the false positive this shape prevents.
// An install reached through a command substitution ($(...) or backticks), a
// piped remote script (curl ... | sh), a script of its own (./scripts/setup.sh)
// or a nested shell (bash -c "...") is out of scope for the hint and stays
// undetected: the hint is a nudge toward Setup, not a gate.
const INSTALL_LIKE_PATTERNS: RegExp[] = [
  /^uv\s+sync\b/,
  /^uv\s+pip\b/,
  /^yarn\s+install\b/,
  // Bare `yarn`, with no subcommand at all, installs.
  /^yarn\s*$/,
  /^npm\s+install\b/,
  /^npm\s+i\b/,
  /^npm\s+ci\b/,
  // In a monorepo `--filter <name>` sits between pnpm and the verb.
  /^pnpm\s+(?:--filter\s+\S+\s+)*(?:install|i)\b/,
  /^bun\s+install\b/,
  /^pip3?\s+install\b/,
  /^python3?\s+-m\s+pip\s+install\b/,
  /^poetry\s+install\b/,
  /^bundle\s+install\b/,
  /^apt(?:-get)?\s+install\b/,
  /^corepack\s+(?:enable|prepare|install)\b/,
  /^nvm\s+install\b/,
  /^make\s+install\b/,
];

/** Command separators that start a new command position: everything after one
 *  of these is a command name again, so `cd x && pnpm install` reaches the
 *  install as its own segment. `||` is listed before `|` because alternation
 *  is ordered. */
const COMMAND_SEPARATORS = /&&|\|\||\||;|\n/;

/** Prefixes that sit in front of the command name without being it: `VAR=value`
 *  assignments, `sudo`, and `env`. Stripped repeatedly, so `sudo apt-get
 *  install` and `env CI=1 yarn install` still reach their install. Each
 *  alternative needs trailing whitespace, so `envsubst` and `sudoedit` are
 *  left alone. */
const COMMAND_NAME_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env)\s+/;

/** A single quote right after a letter or digit is an apostrophe in prose
 *  ("don't"), not a shell quote. */
const WORD_CHAR = /[A-Za-z0-9]/;

/** Replaces every quoted run with a space, so an install phrase inside a
 *  string literal is invisible to the patterns and a separator inside one
 *  cannot split a segment. Inside double quotes a backslash escapes the next
 *  character, so `\"` does not close the string; inside single quotes nothing
 *  escapes. An unterminated quote swallows the rest of the line, which is the
 *  safe direction for a warning, and it is why an apostrophe never opens one:
 *  `echo it's fine && npm install` would otherwise hide a real install two
 *  segments later. Warning-safe rather than shell-exact. */
function blankQuotedRuns(command: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === null) {
      if (char === '"' || (char === "'" && !WORD_CHAR.test(command[i - 1] ?? ""))) {
        quote = char;
        out += " ";
        continue;
      }
      out += char;
      continue;
    }
    if (quote === '"' && char === "\\" && i + 1 < command.length) {
      i += 1;
      continue;
    }
    if (char === quote) quote = null;
  }
  return out;
}

/** Exported so the shell-shape cases can be asserted directly rather than
 *  through twelve renders of the warning. */
export function looksLikeInstallCommand(command: string): boolean {
  if (command.trim() === "") return false;
  return blankQuotedRuns(command)
    .split(COMMAND_SEPARATORS)
    .some((segment) => {
      let head = segment.trimStart();
      while (COMMAND_NAME_PREFIX.test(head)) {
        head = head.replace(COMMAND_NAME_PREFIX, "");
      }
      return INSTALL_LIKE_PATTERNS.some((pattern) => pattern.test(head));
    });
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function isValidEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}

function isValidGroupName(name: string): boolean {
  return name.length > 0 && name.length <= GROUP_NAME_MAX_LENGTH && GROUP_NAME_PATTERN.test(name);
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function emptyConfig(): PrePrCheckConfig {
  return { repositories: [] };
}

function groupIsValid(group: PrePrCheckGroupConfig): boolean {
  const commands = group.commands ?? [];
  const extendsList = group.extends ?? [];
  if (!commands.every(nonBlank)) return false;
  return commands.length > 0 || extendsList.length > 0;
}

/** Single source of truth for "why can't I save": every validity check below
 *  is expressed as "find the first problem", so the boolean checks and the
 *  message shown next to the disabled Save button can never drift apart. */
function firstGroupIssue(group: PrePrCheckGroupConfig): string | null {
  if ((group.commands ?? []).some((c) => !nonBlank(c))) return "empty command";
  if (!groupIsValid(group)) return "needs at least one command or an extended group";
  return null;
}

function firstRepoIssue(repo: PrePrCheckRepositoryConfig): string | null {
  if ((repo.setup ?? []).some((c) => !nonBlank(c))) return "empty setup command";
  const badEnv = (repo.env ?? []).find((n) => !isValidEnvName(n));
  if (badEnv !== undefined) return `invalid env var name "${badEnv}"`;
  if (repo.commandTimeoutMinutes !== undefined && !isPositiveInt(repo.commandTimeoutMinutes)) {
    return "per-command timeout must be a whole number of minutes, 1 or more";
  }

  const groupNames = Object.keys(repo.groups ?? {});
  if (groupNames.length > 0) {
    for (const name of groupNames) {
      if (!isValidGroupName(name)) return `group "${name}": invalid group name`;
      const issue = firstGroupIssue(repo.groups![name]);
      if (issue) return `group "${name}": ${issue}`;
      // The checkboxes only ever offer siblings, so the editor cannot author a
      // dangling reference, but a config written through the API can, and the
      // worker rejects it. Reporting it as clean here would be a lie.
      const unknownRef = (repo.groups![name].extends ?? []).find(
        (ref) => !Object.hasOwn(repo.groups!, ref),
      );
      if (unknownRef !== undefined) return `group "${name}": extends unknown group "${unknownRef}"`;
    }
    // A cycle is a whole-graph property, so it belongs after the per-group
    // pass: the worker rejects it with a 400, and without this the user only
    // found out by clicking Save.
    const cycle = findExtendsCycle(repo.groups!);
    if (cycle) return `cycle in extends: ${cycle.join(" -> ")}`;
    if (repo.gateGroups !== undefined) {
      if (repo.gateGroups.length === 0) return "gate groups selection is empty";
      const unknown = repo.gateGroups.find((name) => !groupNames.includes(name));
      if (unknown !== undefined) return `gate groups references unknown group "${unknown}"`;
    }
    return null;
  }

  // Legacy flat shape: at least one non-blank command.
  const commands = repo.commands ?? [];
  if (commands.length === 0) return "needs at least one command";
  if (commands.some((c) => !nonBlank(c))) return "empty command";
  return null;
}

/** A rename draft the config has not taken. GroupCard keeps every keystroke
 *  visible without committing the rename (see GroupCard's draftName), which
 *  used to mean this state was invisible to Save: the field could read
 *  "checks" while the group was still committed as "lint", Save enabled, and
 *  the group persisted under its old name. Lifted here so it blocks Save
 *  exactly like every other issue.
 *
 *  A draft is held back for two reasons. It duplicates a sibling, or it is
 *  not a legal group name, and the second one is not merely cosmetic: an
 *  invalid draft that reached the config would become an object key, and an
 *  array-index-like key ("2", the first keystroke of "2fa") jumps to the
 *  front of Object.keys. With cards keyed by index that slides a sibling into
 *  the focused slot, so the next keystroke renames the wrong group. */
interface PendingGroupNameDraft {
  repoPath: string;
  attempted: string;
  reason: "duplicate" | "invalid";
}

function firstConfigIssue(
  config: PrePrCheckConfig,
  draft?: PendingGroupNameDraft | null,
): string | null {
  if (draft) {
    return draft.reason === "duplicate"
      ? `${draft.repoPath}: group name "${draft.attempted}" duplicates an existing group`
      : `${draft.repoPath}: group name "${draft.attempted}" is invalid (${GROUP_NAME_RULE})`;
  }
  if (config.batchTimeoutMinutes !== undefined && !isPositiveInt(config.batchTimeoutMinutes)) {
    return "batch timeout must be a whole number of minutes, 1 or more";
  }
  for (const repo of config.repositories) {
    const issue = firstRepoIssue(repo);
    if (issue) return `${repo.repoPath}: ${issue}`;
  }
  return null;
}

function configIsValid(config: PrePrCheckConfig): boolean {
  return firstConfigIssue(config) === null;
}

function nextGroupName(existing: string[]): string {
  let n = existing.length + 1;
  let candidate = `group-${n}`;
  while (existing.includes(candidate)) {
    n += 1;
    candidate = `group-${n}`;
  }
  return candidate;
}

export function RepositoryScriptsScreen({
  initial,
  canEdit,
}: {
  initial: PrePrChecksResponse;
  canEdit: boolean;
}) {
  const [config, setConfig] = useState<PrePrCheckConfig>(
    structuredClone(initial.current?.config ?? emptyConfig()),
  );
  const [versions, setVersions] = useState<PrePrCheckConfigVersion[]>(initial.versions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  // Single slot, owned by whichever GroupCard instance last reported: a
  // human only ever has one rename field focused at a time. `id` (a stable
  // per-GroupCard React useId()) means an unrelated GroupCard clearing its
  // own settled draft never wipes someone else's active one.
  const [groupDraft, setGroupDraftState] = useState<
    ({ id: string } & PendingGroupNameDraft) | null
  >(null);
  // A disabled button takes no focus and announces nothing, so the reason it
  // is disabled has to be reachable on its own.
  const blockerId = useId();

  const savedConfig = versions[0]?.config ?? emptyConfig();
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const issue = firstConfigIssue(config, groupDraft);
  const valid = issue === null;

  function reportGroupDraft(id: string, draft: PendingGroupNameDraft | null) {
    setGroupDraftState((prev) => {
      if (draft === null) return prev?.id === id ? null : prev;
      if (
        prev?.id === id &&
        prev.repoPath === draft.repoPath &&
        prev.attempted === draft.attempted &&
        prev.reason === draft.reason
      ) {
        return prev;
      }
      return { id, ...draft };
    });
  }

  // A closed tab or a browser back/forward loses whatever isn't saved yet.
  // This is the floor: no sticky bar, no cmd+S, just the same "you'll lose
  // this" guard the workflow editor already gives unsaved graph edits.
  useEffect(() => {
    if (!dirty) return;
    if (typeof window === "undefined") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy prompt trigger, still required by Chrome/Edge before 119. An
      // empty string does not count as set, so this has to be truthy.
      e.returnValue = true;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function applyVersion(version: PrePrCheckConfigVersion) {
    setVersions((prev) => [version, ...prev]);
    setConfig(structuredClone(version.config));
  }

  // Sends the whole fetched-and-edited config object back, never a shape
  // rebuilt from a subset of state: that is what used to silently drop
  // top-level fields (batchTimeoutMinutes) that this screen never rendered.
  async function save() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch("/api/pre-pr-checks", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as PrePrCheckSaveResponse).version);
    } catch {
      // A network failure (offline, DNS, CORS) never reaches readErrorMessage
      // because there is no Response; without this the button just stops
      // spinning and nothing tells the operator the edit wasn't saved.
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: number) {
    // Restoring overwrites the in-progress edit, same risk as switching
    // Harness Profiles with unsaved changes, so it gets the same confirm gate.
    if (
      dirty &&
      typeof window !== "undefined" &&
      !window.confirm("Discard unsaved changes and restore this version?")
    ) {
      return;
    }
    setBusy(`restore-${version}`);
    setError(null);
    try {
      const res = await fetch("/api/pre-pr-checks/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as PrePrCheckSaveResponse).version);
      setConfirmRestore(null);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  function updateRepo(index: number, next: PrePrCheckRepositoryConfig) {
    setConfig((prev) => ({
      ...prev,
      repositories: prev.repositories.map((r, i) => (i === index ? next : r)),
    }));
  }

  return (
    <div className="p-6 max-w-[860px]">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="font-body text-[18px] font-semibold text-neutral-900">Repository scripts</h1>
        {canEdit && (
          <button
            onClick={save}
            disabled={!dirty || !valid || busy !== null}
            aria-describedby={issue ? blockerId : undefined}
            className="appearance-none border-none rounded-[3px] px-4 py-2 font-body text-[13px] font-semibold cursor-pointer bg-mariner text-white disabled:opacity-40 disabled:cursor-default"
          >
            {busy === "save" ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
      {canEdit && issue && (
        <p id={blockerId} role="status" className="font-body text-[11px] text-red-600 mb-2">
          Save is disabled: {issue}.
        </p>
      )}
      <p className="font-body text-[13px] text-neutral-600 mb-4">
        Setup commands run once per repository to provision a toolchain the sandbox does not ship.
        Named script groups then run for changed repositories after implementation and before
        branch push / PR creation. A group listed in Gate groups must pass before publication;
        leaving Gate groups empty gates on every group.
      </p>
      {error && (
        <div className="mb-3 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700">
          {error}
        </div>
      )}
      {!canEdit && (
        <div className="mb-3 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          Read-only: ask an admin or owner to change repository scripts.
        </div>
      )}

      <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3 mb-3">
        <div className="font-body text-[12px] font-semibold text-neutral-800">Batch timeout</div>
        <p className="font-body text-[11px] text-neutral-500 mb-[6px]">
          Whole-batch limit across every repository&apos;s script groups, in minutes. Leave blank
          for the default. Not deducted from the run&apos;s duration budget; it does extend how
          long the run holds a dispatch slot.
        </p>
        <TimeoutMinutesField
          value={config.batchTimeoutMinutes}
          disabled={!canEdit}
          placeholder="60"
          max={180}
          onChange={(v) => setConfig((prev) => ({ ...prev, batchTimeoutMinutes: v }))}
        />
      </div>

      {config.repositories.length === 0 && (
        <div className="rounded-[3px] border border-dashed border-neutral-300 px-4 py-6 font-body text-[13px] text-neutral-500 mb-3">
          No repository scripts configured. The gate is disabled.
        </div>
      )}

      {config.repositories.map((repo, index) => (
        <RepoCard
          key={`${repo.provider}:${repo.repoPath}`}
          repo={repo}
          disabled={!canEdit}
          onChange={(next) => updateRepo(index, next)}
          onRemove={() =>
            setConfig((prev) => ({
              ...prev,
              repositories: prev.repositories.filter((_, i) => i !== index),
            }))
          }
          onGroupDraft={reportGroupDraft}
        />
      ))}

      {canEdit && (
        <AddRepository
          configured={config.repositories}
          onAdd={(repo) =>
            setConfig((prev) => ({
              ...prev,
              repositories: [...prev.repositories, { ...repo, groups: { checks: { commands: [""] } } }],
            }))
          }
        />
      )}

      <h2 className="font-body text-[14px] font-semibold text-neutral-900 mt-8 mb-2">History</h2>
      {versions.length === 0 && (
        <div className="font-body text-[12px] text-neutral-500">No versions yet.</div>
      )}
      {versions.map((v) => (
        <div
          key={v.version}
          className="flex items-center gap-3 border-b border-neutral-100 py-2 font-body text-[12px] text-neutral-700"
        >
          <span className="font-mono text-neutral-900">v{v.version}</span>
          <span>{v.createdByLabel}</span>
          <span className="text-neutral-400">{new Date(v.createdAt).toLocaleString()}</span>
          {v.restoredFromVersion !== null && (
            <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
              restored from v{v.restoredFromVersion}
            </span>
          )}
          {canEdit && v.version !== versions[0]?.version && (
            <span className="ml-auto">
              {confirmRestore === v.version ? (
                <>
                  <button
                    onClick={() => restore(v.version)}
                    disabled={busy !== null}
                    className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                  >
                    {busy === `restore-${v.version}` ? "Restoring…" : "Confirm restore"}
                  </button>
                  <button
                    onClick={() => setConfirmRestore(null)}
                    className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer ml-2"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmRestore(v.version)}
                  className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer"
                >
                  Restore
                </button>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function TimeoutMinutesField({
  value,
  disabled,
  placeholder,
  max,
  onChange,
}: {
  value: number | undefined;
  disabled: boolean;
  placeholder?: string;
  /** Optional upper bound, e.g. the batch timeout's server-side cap. Unset
   *  for fields the server does not cap, such as the per-command timeout. */
  max?: number;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      min={1}
      max={max}
      step={1}
      value={value ?? ""}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        if (e.target.value === "") {
          onChange(undefined);
          return;
        }
        const n = Math.round(Number(e.target.value));
        if (!Number.isFinite(n)) return;
        const clamped = max !== undefined ? Math.min(max, n) : n;
        onChange(Math.max(1, clamped));
      }}
      className="w-[100px] rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] text-neutral-900 disabled:bg-app-bg"
    />
  );
}

/** One editable list of shell commands: index, input, remove, add-row. Used for
 *  setup commands, legacy flat commands, and each group's commands. */
function CommandListEditor({
  commands,
  disabled,
  placeholder,
  addLabel,
  warnInstall,
  onChange,
}: {
  commands: string[];
  disabled: boolean;
  placeholder: string;
  addLabel: string;
  warnInstall?: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <>
      {commands.map((command, i) => (
        <div key={i} className="mb-[6px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-neutral-400 w-4 text-right">{i + 1}.</span>
            <input
              value={command}
              disabled={disabled}
              onChange={(e) => onChange(commands.map((c, idx) => (idx === i ? e.target.value : c)))}
              placeholder={placeholder}
              className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] text-neutral-900 disabled:bg-app-bg"
            />
            {!disabled && (
              <button
                onClick={() => onChange(commands.filter((_, idx) => idx !== i))}
                aria-label="Remove command"
                className="appearance-none border-none bg-transparent font-mono text-[13px] text-neutral-400 hover:text-red-600 cursor-pointer"
              >
                ×
              </button>
            )}
          </div>
          {command.trim() === "" && (
            <div className="ml-6 mt-[3px] font-body text-[11px] text-red-600">
              Empty command. Fill it in or remove this row before saving.
            </div>
          )}
          {warnInstall && looksLikeInstallCommand(command) && (
            <div className="ml-6 mt-[3px] font-body text-[11px] text-burnt-orange">
              This looks like an install command. Consider moving it to Setup, which runs once
              before script groups.
            </div>
          )}
        </div>
      ))}
      {!disabled && (
        <button
          onClick={() => onChange([...commands, ""])}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer px-0"
        >
          + {addLabel}
        </button>
      )}
    </>
  );
}

function EnvNamesEditor({
  names,
  disabled,
  onChange,
}: {
  names: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <>
      {names.map((name, i) => {
        const invalid = !isValidEnvName(name);
        return (
          <div key={i} className="mb-[6px]">
            <div className="flex items-center gap-2">
              <input
                value={name}
                disabled={disabled}
                onChange={(e) => onChange(names.map((n, idx) => (idx === i ? e.target.value : n)))}
                placeholder="MY_TOKEN"
                className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] text-neutral-900 disabled:bg-app-bg"
              />
              {!disabled && (
                <button
                  onClick={() => onChange(names.filter((_, idx) => idx !== i))}
                  aria-label="Remove env var name"
                  className="appearance-none border-none bg-transparent font-mono text-[13px] text-neutral-400 hover:text-red-600 cursor-pointer"
                >
                  ×
                </button>
              )}
            </div>
            {invalid && (
              <div className="ml-0 mt-[3px] font-body text-[11px] text-red-600">
                Must start with a letter and contain only uppercase letters, digits, and
                underscores (SCREAMING_SNAKE_CASE). The worker also refuses any name it has not
                allowlisted for forwarding.
              </div>
            )}
          </div>
        );
      })}
      {!disabled && (
        <button
          onClick={() => onChange([...names, ""])}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer px-0"
        >
          + Add env var name
        </button>
      )}
    </>
  );
}

function GateGroupsEditor({
  groupNames,
  gateGroups,
  disabled,
  onChange,
}: {
  groupNames: string[];
  gateGroups: string[] | undefined;
  disabled: boolean;
  onChange: (next: string[] | undefined) => void;
}) {
  const allSelected = gateGroups === undefined;
  return (
    <div>
      <label className="flex items-center gap-2 mb-1 font-body text-[12px] text-neutral-800">
        <input
          type="checkbox"
          aria-label="Gate on all groups"
          checked={allSelected}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? undefined : groupNames)}
          className="w-3.5 h-3.5 accent-mariner"
        />
        Gate on all groups
      </label>
      {allSelected && (
        <p className="ml-5 mb-1 font-body text-[10px] text-neutral-500">{GATING_ALL_GROUPS_NOTE}</p>
      )}
      {!allSelected && (
        <div className="ml-5 flex flex-col gap-1">
          {groupNames.map((name) => {
            const selected = gateGroups.includes(name);
            return (
              <label key={name} className="flex items-center gap-2 font-mono text-[12px] text-neutral-700">
                <input
                  type="checkbox"
                  aria-label={`Gate on group ${name}`}
                  checked={selected}
                  disabled={disabled}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...gateGroups, name]
                      : gateGroups.filter((g) => g !== name);
                    // An empty selection is rejected by the server, so clearing
                    // the last box falls back to "all groups" instead.
                    onChange(next.length > 0 ? next : undefined);
                  }}
                  className="w-3.5 h-3.5 accent-mariner"
                />
                {name}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GroupCard({
  name,
  group,
  otherGroupNames,
  cyclePath,
  canDelete,
  willUngateOnDelete,
  disabled,
  onRename,
  onDelete,
  onCommandsChange,
  onToggleExtends,
  onToggleRestoreTree,
  onDraftChange,
}: {
  name: string;
  group: PrePrCheckGroupConfig;
  otherGroupNames: string[];
  /** The extends cycle this group sits on, already narrowed to this card by
   *  GroupsSection, or null when it is not on one. */
  cyclePath: string[] | null;
  canDelete: boolean;
  /** True when this is the only group Gate groups currently selects, so
   *  deleting it collapses Gate groups back to "all groups". */
  willUngateOnDelete: boolean;
  disabled: boolean;
  onRename: (next: string) => void;
  onDelete: () => void;
  onCommandsChange: (next: string[]) => void;
  onToggleExtends: (ref: string, checked: boolean) => void;
  onToggleRestoreTree: (checked: boolean) => void;
  /** Reports a held-back draft rename up to the screen, which folds it into
   *  the Save-blocking issue: the draft never commits (see below), so
   *  without this Save had no way to know a field reads a name the config
   *  never actually took. The id is this card's own useId() (see below), so
   *  a stale closure from an earlier render still clears the right slot. */
  onDraftChange: (id: string, draft: Omit<PendingGroupNameDraft, "repoPath"> | null) => void;
}) {
  const nameInvalid = !isValidGroupName(name);
  const extendsList = group.extends ?? [];
  const noCommandsOrExtends = (group.commands ?? []).length === 0 && extendsList.length === 0;

  // A live-as-you-type rename cannot go straight into the committed group
  // key: typing toward a name that collides with a sibling would otherwise
  // either overwrite that sibling or (with the guard below) just silently
  // stop taking keystrokes, and typing toward one that is not a legal name
  // would put a key like "2" in the config, reordering the cards. The draft
  // buffer keeps every keystroke visible; only a legal, non-colliding draft
  // ever reaches onRename.
  const [draftName, setDraftName] = useState(name);
  const [committedName, setCommittedName] = useState(name);
  if (name !== committedName) {
    setCommittedName(name);
    setDraftName(name);
  }
  const pendingReason: PendingGroupNameDraft["reason"] | null =
    draftName === name
      ? null
      : otherGroupNames.includes(draftName)
        ? "duplicate"
        : !isValidGroupName(draftName)
          ? "invalid"
          : null;

  // Stable for this card's whole lifetime, unlike `name` (changes on a
  // successful rename) or its index (shifts when a sibling is deleted), so
  // the draft report always targets the same slot even across those.
  const draftId = useId();
  // The draft is visible but never committed while held back, so Save's own
  // validity has to be told separately: report on every change, and clear
  // on unmount so a deleted card cannot leave a stale block behind.
  useEffect(() => {
    onDraftChange(draftId, pendingReason ? { attempted: draftName, reason: pendingReason } : null);
  }, [draftId, pendingReason, draftName, onDraftChange]);
  useEffect(() => {
    return () => onDraftChange(draftId, null);
    // Unmount-only: clears this card's own report, not a sibling's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  function handleRenameChange(next: string) {
    setDraftName(next);
    if (next === name || otherGroupNames.includes(next) || !isValidGroupName(next)) return;
    onRename(next);
  }

  return (
    <div className="rounded-[3px] border border-neutral-200 bg-white px-3 py-2 mb-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <input
          value={draftName}
          disabled={disabled}
          onChange={(e) => handleRenameChange(e.target.value)}
          className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[4px] font-mono text-[12px] font-semibold text-neutral-900 disabled:bg-app-bg"
        />
        {!disabled && canDelete && (
          <button
            onClick={onDelete}
            className="appearance-none border-none bg-transparent font-body text-[11px] text-neutral-500 hover:text-red-600 cursor-pointer"
          >
            Remove group
          </button>
        )}
      </div>
      <p className="mb-2 font-body text-[10px] text-neutral-500">
        Workflow blocks that name this group will not follow a rename or removal and will report
        not_run.
      </p>
      {pendingReason === "duplicate" && (
        <div className="mb-2 font-body text-[11px] text-red-600">
          A group named &quot;{draftName}&quot; already exists.
        </div>
      )}
      {(nameInvalid || pendingReason === "invalid") && (
        <div className="mb-2 font-body text-[11px] text-red-600">
          Group names start with a lowercase letter and contain only lowercase letters, digits,
          and hyphens, up to {GROUP_NAME_MAX_LENGTH} characters.
        </div>
      )}
      {canDelete && willUngateOnDelete && (
        <div className="mb-2 font-body text-[11px] text-burnt-orange">
          This is the only group Gate groups selects. Removing it will leave nothing selected.{" "}
          {GATING_ALL_GROUPS_NOTE}
        </div>
      )}

      <div className="font-body text-[11px] font-semibold text-neutral-700 mb-1">Commands</div>
      <CommandListEditor
        commands={group.commands ?? []}
        disabled={disabled}
        placeholder="pnpm test"
        addLabel="Add command"
        warnInstall
        onChange={onCommandsChange}
      />
      {noCommandsOrExtends && (
        <div className="mb-2 font-body text-[11px] text-red-600">
          This group has no commands and does not extend another group, so it will not run. Add a
          command or extend a group below.
        </div>
      )}

      {otherGroupNames.length > 0 && (
        <div className="mt-2">
          <div className="font-body text-[11px] font-semibold text-neutral-700 mb-1">Extends</div>
          <p className="font-body text-[10px] text-neutral-500 mb-1">
            Run these sibling groups&apos; commands first.
          </p>
          <div className="flex flex-wrap gap-3">
            {otherGroupNames.map((ref) => (
              <label key={ref} className="flex items-center gap-1 font-mono text-[11px] text-neutral-700">
                <input
                  type="checkbox"
                  aria-label={`Extend ${ref}`}
                  checked={extendsList.includes(ref)}
                  disabled={disabled}
                  onChange={(e) => onToggleExtends(ref, e.target.checked)}
                  className="w-3.5 h-3.5 accent-mariner"
                />
                {ref}
              </label>
            ))}
          </div>
          {cyclePath && (
            <div className="mt-1 font-body text-[11px] text-red-600">
              Part of an extends cycle: {cyclePath.join(" -> ")}.
            </div>
          )}
        </div>
      )}

      <label className="mt-2 flex items-center gap-2 font-body text-[11px] text-neutral-700">
        <input
          type="checkbox"
          checked={group.restoreTree !== false}
          disabled={disabled}
          onChange={(e) => onToggleRestoreTree(e.target.checked)}
          className="w-3.5 h-3.5 accent-mariner"
        />
        Restore tree after running
      </label>
      <p className="font-body text-[10px] text-neutral-500 mt-[2px]">
        On, the tracked files this group&apos;s commands modified are restored afterward. Turn
        off only for a group whose job is to edit the tree, such as an auto-formatter.
      </p>
    </div>
  );
}

function GroupsSection({
  repo,
  disabled,
  onChange,
  onGroupDraft,
}: {
  repo: PrePrCheckRepositoryConfig;
  disabled: boolean;
  onChange: (next: PrePrCheckRepositoryConfig) => void;
  onGroupDraft: (id: string, draft: PendingGroupNameDraft | null) => void;
}) {
  const groups = repo.groups ?? {};
  // Key order, not a sort: the worker rebuilds `groups` with canonical
  // (code-point) key order when it reads the config back, so what arrives
  // here is already the order to show. Sorting again on the client would be
  // actively wrong, because cards are keyed by index while every keystroke
  // commits a rename, so a name crossing a sort boundary mid-typing would
  // slide another group into the focused slot and re-target the next keystroke.
  const names = Object.keys(groups);
  // Once per repository, so every card on the cycle can name it where the
  // user is rather than only in the blocker above Save.
  const cyclePath = findExtendsCycle(groups);

  function renameGroup(oldName: string, newName: string) {
    // `in` walks the prototype chain, so "constructor", "toString" and the
    // like would look permanently taken even though no sibling group is
    // actually named that. Object.hasOwn checks only the group's own keys.
    if (newName === oldName || Object.hasOwn(groups, newName)) return;
    const nextGroups: Record<string, PrePrCheckGroupConfig> = {};
    for (const [n, g] of Object.entries(groups)) {
      const key = n === oldName ? newName : n;
      const nextExtends = g.extends?.map((ref) => (ref === oldName ? newName : ref));
      nextGroups[key] = nextExtends ? { ...g, extends: nextExtends } : g;
    }
    const gateGroups = repo.gateGroups?.map((g) => (g === oldName ? newName : g));
    onChange({ ...repo, groups: nextGroups, ...(gateGroups ? { gateGroups } : {}) });
  }

  function deleteGroup(name: string) {
    if (names.length <= 1) return;
    const nextGroups: Record<string, PrePrCheckGroupConfig> = {};
    for (const [n, g] of Object.entries(groups)) {
      if (n === name) continue;
      const nextExtends = g.extends?.filter((ref) => ref !== name);
      nextGroups[n] = nextExtends ? { ...g, extends: nextExtends.length > 0 ? nextExtends : undefined } : g;
    }
    const gateGroups = repo.gateGroups?.filter((g) => g !== name);
    onChange({
      ...repo,
      groups: nextGroups,
      ...(gateGroups !== undefined ? { gateGroups: gateGroups.length > 0 ? gateGroups : undefined } : {}),
    });
  }

  function addGroup() {
    const name = nextGroupName(names);
    onChange({ ...repo, groups: { ...groups, [name]: { commands: [""] } } });
  }

  function updateGroup(name: string, next: PrePrCheckGroupConfig) {
    onChange({ ...repo, groups: { ...groups, [name]: next } });
  }

  return (
    <div>
      <p className="font-body text-[11px] text-neutral-500 mb-2">
        Script groups are listed by name. Run order follows extends, not the position in this list.
      </p>
      {names.map((name, i) => (
        <GroupCard
          key={i}
          name={name}
          group={groups[name]}
          otherGroupNames={names.filter((n) => n !== name)}
          cyclePath={cyclePath?.includes(name) ? cyclePath : null}
          canDelete={names.length > 1}
          willUngateOnDelete={
            repo.gateGroups !== undefined &&
            repo.gateGroups.length === 1 &&
            repo.gateGroups[0] === name
          }
          disabled={disabled}
          onRename={(next) => renameGroup(name, next)}
          onDelete={() => deleteGroup(name)}
          onCommandsChange={(commands) => updateGroup(name, { ...groups[name], commands })}
          onToggleExtends={(ref, checked) => {
            const current = groups[name].extends ?? [];
            const next = checked ? [...current, ref] : current.filter((r) => r !== ref);
            updateGroup(name, { ...groups[name], extends: next.length > 0 ? next : undefined });
          }}
          onToggleRestoreTree={(checked) =>
            updateGroup(name, { ...groups[name], restoreTree: checked ? undefined : false })
          }
          onDraftChange={(id, draft) =>
            onGroupDraft(id, draft !== null ? { repoPath: repo.repoPath, ...draft } : null)
          }
        />
      ))}
      {!disabled && (
        <button
          onClick={addGroup}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer px-0 mb-3"
        >
          + Add group
        </button>
      )}

      <div className="mt-1">
        <div className="font-body text-[12px] font-semibold text-neutral-800 mb-1">Gate groups</div>
        <p className="font-body text-[11px] text-neutral-500 mb-1">
          Groups the publication gate requires to pass.
        </p>
        <GateGroupsEditor
          groupNames={names}
          gateGroups={repo.gateGroups}
          disabled={disabled}
          onChange={(next) => onChange({ ...repo, gateGroups: next })}
        />
      </div>
    </div>
  );
}

function RepoCard({
  repo,
  disabled,
  onChange,
  onRemove,
  onGroupDraft,
}: {
  repo: PrePrCheckRepositoryConfig;
  disabled: boolean;
  onChange: (next: PrePrCheckRepositoryConfig) => void;
  onRemove: () => void;
  onGroupDraft: (id: string, draft: PendingGroupNameDraft | null) => void;
}) {
  const isGrouped = Object.keys(repo.groups ?? {}).length > 0;

  return (
    <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[13px] text-neutral-900">
          {repo.repoPath}
          <span className="ml-2 rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-600">
            {repo.provider}
          </span>
        </div>
        {!disabled && (
          <button
            onClick={onRemove}
            className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 hover:text-red-600 cursor-pointer"
          >
            Remove
          </button>
        )}
      </div>

      <div className="font-body text-[12px] font-semibold text-neutral-800">Setup</div>
      <p className="font-body text-[11px] text-neutral-500 mb-[6px]">
        Runs once before any script group, for installing a toolchain the sandbox does not ship.
        A failed setup command blocks the run.
      </p>
      <CommandListEditor
        commands={repo.setup ?? []}
        disabled={disabled}
        placeholder="make bootstrap"
        addLabel="Add setup command"
        onChange={(setup) => onChange({ ...repo, setup })}
      />

      <div className="font-body text-[12px] font-semibold text-neutral-800 mt-3 mb-[6px]">
        {isGrouped ? "Script groups" : "Commands (legacy)"}
      </div>
      {isGrouped ? (
        <GroupsSection
          repo={repo}
          disabled={disabled}
          onChange={onChange}
          onGroupDraft={onGroupDraft}
        />
      ) : (
        <>
          <CommandListEditor
            commands={repo.commands ?? []}
            disabled={disabled}
            placeholder="pnpm test"
            addLabel="Add command"
            warnInstall
            onChange={(commands) => onChange({ ...repo, commands })}
          />
          {!disabled && (
            <button
              onClick={() =>
                onChange({
                  ...repo,
                  groups: { checks: { commands: repo.commands ?? [] } },
                  commands: undefined,
                })
              }
              className="mt-2 appearance-none rounded-[3px] border border-neutral-300 bg-white px-2 py-1 font-body text-[11px] text-neutral-700 cursor-pointer hover:bg-app-bg"
            >
              Convert to groups
            </button>
          )}
          <p className="mt-1 font-body text-[10px] text-neutral-500">
            Convert to groups to add environment variables. The legacy command-list shape does
            not support them.
          </p>
        </>
      )}

      {isGrouped && (
        <>
          <div className="font-body text-[12px] font-semibold text-neutral-800 mt-3 mb-[2px]">
            Env vars forwarded
          </div>
          <p className="font-body text-[11px] text-neutral-500 mb-[6px]">
            NAMES only, never values. The worker looks up each one in its own environment and
            refuses any name it has not allowlisted for forwarding.
          </p>
          <EnvNamesEditor
            names={repo.env ?? []}
            disabled={disabled}
            onChange={(env) => onChange({ ...repo, env })}
          />
        </>
      )}

      <div className="font-body text-[12px] font-semibold text-neutral-800 mt-3 mb-[6px]">
        Per-command timeout (minutes)
      </div>
      <TimeoutMinutesField
        value={repo.commandTimeoutMinutes}
        disabled={disabled}
        onChange={(v) => onChange({ ...repo, commandTimeoutMinutes: v })}
      />
    </div>
  );
}

function providerStatusLabel(status: RepositoryProviderStatus): string {
  if (status.status === "not_connected") return "not connected";
  if (status.status === "error") return status.error ?? "could not list repositories";
  return "ready";
}

function AddRepository({
  configured,
  onAdd,
}: {
  configured: PrePrCheckRepositoryConfig[];
  onAdd: (repo: { provider: "github" | "gitlab"; repoPath: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RepositoryOption[] | null>(null);
  const [providers, setProviders] = useState<RepositoryProviderStatus[]>([]);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [manualProvider, setManualProvider] = useState<"github" | "gitlab">("github");
  const [manualPath, setManualPath] = useState("");

  const isConfigured = (provider: string, repoPath: string) =>
    configured.some((r) => r.provider === provider && r.repoPath === repoPath);

  async function openPicker() {
    setOpen(true);
    if (options || failed) return;
    try {
      const res = await fetch("/api/repositories");
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as RepositoriesResponse;
      setOptions(data.repositories);
      setProviders(data.providers);
    } catch {
      setFailed(true);
    }
  }

  function addManual() {
    const repoPath = manualPath.trim();
    if (!repoPath || isConfigured(manualProvider, repoPath)) return;
    onAdd({ provider: manualProvider, repoPath });
    setManualPath("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={openPicker}
        className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[13px] text-neutral-800 cursor-pointer hover:bg-app-bg"
      >
        + Add repository
      </button>
    );
  }

  const listed = (options ?? [])
    .filter((o) => !o.archived)
    .filter((o) => o.repoPath.toLowerCase().includes(filter.toLowerCase()));
  // A provider the catalog couldn't list from (most often a stale or missing
  // GitLab token, 401 on the metadata call) is exactly the case where an
  // operator needs to type the repository in by hand, so its status is
  // surfaced rather than swallowed into a generic "failed" state.
  const problemProviders = providers.filter((p) => p.status !== "ready");

  return (
    <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="font-body text-[13px] font-semibold text-neutral-900">Add repository</span>
        <button
          onClick={() => setOpen(false)}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
        >
          Close
        </button>
      </div>
      {options === null && !failed && (
        <div className="font-body text-[12px] text-neutral-500 py-2">Loading repositories…</div>
      )}
      {failed && (
        <div className="mb-2 rounded-[3px] border border-red-200 bg-red-50 px-2 py-[6px] font-body text-[11px] text-red-700">
          Couldn&apos;t reach the repository catalog. Enter the repository manually below.
        </div>
      )}
      {problemProviders.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {problemProviders.map((p) => (
            <div
              key={p.provider}
              className="rounded-[3px] border border-red-200 bg-red-50 px-2 py-[6px] font-body text-[11px] text-red-700"
            >
              {p.provider}: {providerStatusLabel(p)}. Enter a {p.provider} repository manually
              below.
            </div>
          ))}
        </div>
      )}
      {options !== null && !failed && (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] mb-2"
          />
          {listed.length === 0 ? (
            <div className="font-body text-[12px] text-neutral-500 py-2">
              No repositories available{filter ? " matching the filter" : " from a connected provider"}
              . Enter one manually below.
            </div>
          ) : (
            <div className="max-h-[220px] overflow-y-auto">
              {listed.map((o) => {
                const taken = isConfigured(o.provider, o.repoPath);
                return (
                  <button
                    key={`${o.provider}:${o.repoPath}`}
                    disabled={taken}
                    onClick={() => {
                      onAdd({ provider: o.provider, repoPath: o.repoPath });
                      setOpen(false);
                    }}
                    className="w-full appearance-none border-none bg-transparent text-left flex items-center gap-2 px-1 py-[6px] font-mono text-[12px] text-neutral-800 cursor-pointer hover:bg-app-bg rounded-[3px] disabled:opacity-40 disabled:cursor-default"
                  >
                    {o.repoPath}
                    <span className="rounded-[3px] bg-app-bg px-[5px] py-[1px] font-mono text-[10px] uppercase text-neutral-500">
                      {o.provider}
                    </span>
                    {taken && <span className="ml-auto font-body text-[11px] text-neutral-400">added</span>}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      <div className="mt-2 flex items-center gap-2 border-t border-neutral-200 pt-2">
        <span className="font-body text-[11px] text-neutral-500">Add manually:</span>
        <div className="w-[120px]">
          <Listbox
            options={[
              { value: "github", label: "github" },
              { value: "gitlab", label: "gitlab" },
            ]}
            value={manualProvider}
            ariaLabel="VCS provider"
            onChange={(v) => setManualProvider(v as "github" | "gitlab")}
          />
        </div>
        <input
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          placeholder="owner/repo"
          className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[5px] font-mono text-[12px]"
        />
        <button
          onClick={addManual}
          className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-2 py-[5px] font-body text-[12px] cursor-pointer"
        >
          Add
        </button>
      </div>
    </div>
  );
}
