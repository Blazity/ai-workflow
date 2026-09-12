"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { FlowNodeDef } from "@/lib/flows";
import type { PrePrCheckRepositoryConfig, VcsProviderKind } from "@shared/contracts";
import { REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE } from "@shared/contracts";
import { isRepositoryScriptGroupName } from "@/lib/workflow-editor/params";
import { repositoryKey } from "@/lib/workflow-editor/repository-scope";
import { useRepositoryScopeContext } from "../repository-scope-context";
import { ConfigField, arr, inputCls } from "./shared";
import type { ConfigChange } from "./types";
import { apiClient } from "@/lib/api/client";

export function RepositoryScriptsLink() {
  return (
    <Link
      href="/repositories"
      target="_blank"
      rel="noreferrer"
      className="text-mariner underline"
    >
      Repositories<span aria-hidden="true"> ↗</span>
    </Link>
  );
}

interface ScriptGroupCatalogRepository {
  /** `provider:repoPath` lowercased, the repo-wide identity for a repository.
   *  A path alone is not one: the same org/name can exist on GitHub and on
   *  GitLab, and they are different repositories with different scripts. */
  key: string;
  provider: VcsProviderKind;
  repoPath: string;
  /** repoPath on its own, qualified with the provider only when another
   *  repository in scope shares the path. */
  label: string;
  /** Groups this repository declares, after legacy normalization. */
  groupNames: string[];
  /** Null means the repository sets no gate groups, so every group runs there. */
  gateGroups: string[] | null;
}

interface ScriptGroupCatalogEntry {
  name: string;
  /** Keys of the repositories declaring this group, in configuration order. */
  repoKeys: string[];
  /** True when at least one declaring repository runs it with restoreTree
   *  false, so the group is allowed to leave the tree modified. */
  writes: boolean;
}

interface ScriptGroupCatalog {
  /** Repositories in this workflow's scope, in configuration order. The
   *  denominator of every coverage counter. */
  repositories: ScriptGroupCatalogRepository[];
  /** Union of group names declared in scope, most widely declared first. */
  groups: ScriptGroupCatalogEntry[];
  /** True when a repository pin narrowed the tenant configuration, so counters
   *  can say which population they are counting. */
  pinned: boolean;
}

export type ScriptGroupCatalogState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; catalog: ScriptGroupCatalog };

function buildScriptGroupCatalog(
  entries: PrePrCheckRepositoryConfig[],
  pinned: boolean,
): ScriptGroupCatalog {
  const pathCounts = new Map<string, number>();
  for (const repo of entries) {
    const path = repo.repoPath.toLowerCase();
    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  }
  const repositories: ScriptGroupCatalogRepository[] = [];
  const byName = new Map<string, ScriptGroupCatalogEntry>();
  for (const repo of entries) {
    const declared = Object.keys(repo.groups ?? {});
    // The engine normalizes a legacy flat-commands repository into a single
    // "checks" group at run time; the stored config never spells that out, so
    // without this an all-legacy tenant reads as declaring nothing at all.
    const groupNames =
      declared.length > 0 ? declared : (repo.commands ?? []).length > 0 ? ["checks"] : [];
    const key = repositoryKey(repo);
    repositories.push({
      key,
      provider: repo.provider,
      repoPath: repo.repoPath,
      label:
        (pathCounts.get(repo.repoPath.toLowerCase()) ?? 0) > 1
          ? `${repo.provider}:${repo.repoPath}`
          : repo.repoPath,
      groupNames,
      gateGroups:
        Array.isArray(repo.gateGroups) && repo.gateGroups.length > 0 ? repo.gateGroups : null,
    });
    for (const name of groupNames) {
      const entry = byName.get(name) ?? { name, repoKeys: [], writes: false };
      entry.repoKeys.push(key);
      if (repo.groups?.[name]?.restoreTree === false) entry.writes = true;
      byName.set(name, entry);
    }
  }
  const groups = [...byName.values()].sort(
    (a, b) => b.repoKeys.length - a.repoKeys.length || a.name.localeCompare(b.name),
  );
  return { repositories, groups, pinned };
}

/**
 * The Repository scripts configuration this workflow can actually reach,
 * reduced to what the group picker needs.
 *
 * The tenant list is narrowed by the definition's repository pin: a coverage
 * counter that includes repositories the workflow will never touch reads as a
 * gap that is not there, and a gate readout for them is fiction. Loading, a
 * failed fetch and an empty configuration stay three separate answers, because
 * collapsing them is what let a failed fetch look like "no groups configured".
 */
function useScriptGroupCatalog(): {
  state: ScriptGroupCatalogState;
  reload: () => void;
} {
  const repositoryScope = useRepositoryScopeContext();
  const pins = repositoryScope?.scope.repositories ?? [];
  // A stable dependency for the effect: the pin is an array rebuilt on every
  // editor render, so comparing it by identity would refetch forever.
  const pinKey = pins.map(repositoryKey).sort().join("\n");
  const [state, setState] = useState<ScriptGroupCatalogState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // A background refetch keeps the catalog on screen: only a first load or a
    // retry out of failure has nothing better to show than "loading".
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    apiClient.prePrChecks.get({ cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.data;
      })
      .then((data) => {
        if (cancelled) return;
        const all = data.current?.config.repositories ?? [];
        const pinnedKeys = new Set(pinKey === "" ? [] : pinKey.split("\n"));
        const inScope =
          pinnedKeys.size > 0
            ? all.filter((repo) => pinnedKeys.has(repositoryKey(repo)))
            : all;
        setState({
          status: "ready",
          catalog: buildScriptGroupCatalog(inScope, pinnedKeys.size > 0),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, pinKey]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  // The Repositories links open in a new tab on purpose, so coming back to the
  // editor with a group just renamed there is the normal flow, not the edge
  // case. Refetching on return keeps the picker from warning about a name that
  // now exists.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);
  return { state, reload };
}

const catalogLabelCls =
  "font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500";
const smallButtonCls =
  "appearance-none rounded-xs border border-neutral-300 bg-white px-1.5 py-[2px] font-mono text-[10px] text-neutral-700 hover:bg-app-bg disabled:cursor-default disabled:opacity-40";

/** How many repositories the counters are counting, and a way to refetch. Every
 *  state says which of the three it is; none of them is a blank field. */
function ScriptCatalogStatus({
  state,
  onReload,
}: {
  state: ScriptGroupCatalogState;
  onReload: () => void;
}) {
  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-1.5">
        <span className={catalogLabelCls}>Configured:</span>
        <span className="font-mono text-[10px] text-neutral-500">loading...</span>
      </div>
    );
  }
  if (state.status === "unavailable") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <span className={`${catalogLabelCls} text-amber-800`}>Configured:</span>
          <span className="font-mono text-[10px] text-amber-800">unavailable</span>
          <button type="button" onClick={onReload} className={smallButtonCls}>
            Retry
          </button>
        </div>
        <div className="font-body text-[11px] leading-[1.4] text-neutral-600">
          Group names could not be checked against Repository scripts.
        </div>
      </div>
    );
  }
  const { repositories, pinned } = state.catalog;
  return (
    <div className="flex items-center gap-1.5">
      <span className={catalogLabelCls}>Configured:</span>
      <span className="font-mono text-[10px] text-neutral-500">
        {repositories.length} {pinned ? "pinned" : ""}
        {pinned ? " " : ""}
        {repositories.length === 1 ? "repo" : "repos"}
      </span>
      <button type="button" onClick={onReload} className={smallButtonCls}>
        Refresh
      </button>
    </div>
  );
}

/** Nothing in scope has scripts. Separate from a failed fetch, and separate
 *  again from a pin that simply selected repositories nobody configured. */
function NoScriptsInScope({ pinned }: { pinned: boolean }) {
  return (
    <div className="font-body text-[11px] leading-[1.4] text-neutral-600">
      {pinned
        ? "None of the repositories pinned to this workflow has repository scripts configured."
        : "No repository scripts configured yet."}
    </div>
  );
}

/** The publication gate's resolved selection, one row per repository in scope:
 *  the repository's gate groups when it sets them, every declared group
 *  otherwise. The runner resolves it exactly this way, and spelling it out is
 *  the difference between "checks run" and knowing which. */
function GateSelectionList({
  state,
  onReload,
}: {
  state: ScriptGroupCatalogState;
  onReload: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <ScriptCatalogStatus state={state} onReload={onReload} />
      {state.status === "ready" &&
        (state.catalog.repositories.length === 0 ? (
          <NoScriptsInScope pinned={state.catalog.pinned} />
        ) : (
          <div className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto">
            {state.catalog.repositories.map((repo) => (
              <div
                key={repo.key}
                className="font-mono text-[11px] leading-[1.5] text-neutral-700"
              >
                {repo.label} ·{" "}
                {repo.gateGroups
                  ? `gate groups: ${repo.gateGroups.join(", ")}`
                  : `every group runs at the gate (${repo.groupNames.length} ${
                      repo.groupNames.length === 1 ? "group" : "groups"
                    })`}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

interface ScriptGroupRowModel {
  name: string;
  repoKeys: string[];
  writes: boolean;
  /** Selected but declared by no repository in scope, or not a legal group name
   *  at all. */
  flag: "malformed" | "unknown" | null;
}

/** One group in the picker: checkbox, mono name, a WRITES tag when the group
 *  may leave the tree modified, and how many repositories in scope declare it.
 *  The counter expands to the per-repository breakdown, because "3/4" only
 *  becomes actionable once you know which repository is the odd one out. */
function ScriptGroupRow({
  row,
  allRepositories,
  coverageKnown,
  pinned,
  checked,
  onToggle,
}: {
  row: ScriptGroupRowModel;
  allRepositories: ScriptGroupCatalogRepository[];
  coverageKnown: boolean;
  pinned: boolean;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] text-neutral-700">
          <input
            type="checkbox"
            aria-label={`Run group ${row.name}`}
            checked={checked}
            onChange={(e) => onToggle(e.target.checked)}
            className="w-3.5 h-3.5 accent-mariner"
          />
          <span
            title={row.name}
            className={row.flag === "malformed" ? "truncate text-red-700" : "truncate"}
          >
            {row.name}
          </span>
          {row.writes && (
            <span
              title="This group runs with restoreTree false: it is allowed to leave tracked files modified."
              className="rounded-xs border border-amber-300 bg-amber-50 px-1 py-[1px] font-mono text-[9px] uppercase tracking-[0.06em] text-amber-800"
            >
              Writes
            </span>
          )}
        </label>
        {coverageKnown && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`Repository coverage for ${row.name}`}
            onClick={() => setExpanded((v) => !v)}
            className="appearance-none shrink-0 border-none bg-transparent p-0 font-mono text-[10px] text-neutral-500 hover:text-neutral-700"
          >
            {row.repoKeys.length}/{allRepositories.length} {pinned ? "pinned " : ""}repos
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-5 flex flex-col gap-0.5">
          {allRepositories.map((repo) => (
            <div key={repo.key} className="font-mono text-[10px] leading-[1.5] text-neutral-500">
              {row.repoKeys.includes(repo.key) ? "✓" : "-"} {repo.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The escape hatch: a group Repository scripts does not declare yet is a
 *  legitimate thing to select, but a name the server would refuse is not, so
 *  this validates against the shared pattern and never adds a bad one. */
function AddScriptGroupName({ onAdd }: { onAdd: (name: string) => void }) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const invalid = trimmed !== "" && !isRepositoryScriptGroupName(trimmed);
  function submit() {
    if (trimmed === "" || !isRepositoryScriptGroupName(trimmed)) return;
    onAdd(trimmed);
    setDraft("");
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={draft}
          spellCheck={false}
          aria-label="Add a group name"
          placeholder="Add a group name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
          className={`${inputCls} flex-1 min-w-0`}
        />
        <button
          type="button"
          disabled={trimmed === "" || invalid}
          onClick={submit}
          className={smallButtonCls}
        >
          Add
        </button>
      </div>
      {invalid && (
        <div className="font-body text-[11px] leading-[1.4] text-red-700">
          {REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE}
        </div>
      )}
    </div>
  );
}

/** Shared group picker for run_scripts and run_checks: one row per group
 *  declared in scope, plus a row for every selected name that scope does not
 *  declare. The warnings split by severity, because the three cases have three
 *  different consequences: a malformed name cannot be saved, an undeclared one
 *  runs nothing while the block still reports a result, and partial coverage is
 *  normal but silent. */
function ScriptGroupsPicker({
  block,
  selected: rawSelected,
  state,
  onReload,
  disabled,
  onChange,
}: {
  block: "run_scripts" | "run_checks";
  selected: string[];
  state: ScriptGroupCatalogState;
  onReload: () => void;
  disabled: boolean;
  /** Always the full, deduped selection, empty array included. What an empty
   *  selection means to the params is the field's decision, not the picker's. */
  onChange: (next: string[]) => void;
}) {
  // The free-text field this replaced never deduped, so a legacy definition can
  // carry the same name twice. One row per name, and the next write drops the
  // duplicate for good.
  const selected = [...new Set(rawSelected)];
  const catalog = state.status === "ready" ? state.catalog : null;
  const allRepositories = catalog?.repositories ?? [];
  const coverageKnown = catalog !== null;
  const pinned = catalog?.pinned ?? false;
  const declared = new Map(catalog?.groups.map((group) => [group.name, group]) ?? []);

  const rows: ScriptGroupRowModel[] = [
    ...(catalog?.groups ?? []).map((group) => ({
      name: group.name,
      repoKeys: group.repoKeys,
      writes: group.writes,
      flag: null as ScriptGroupRowModel["flag"],
    })),
    ...selected
      .filter((name) => !declared.has(name))
      .map((name) => ({
        name,
        repoKeys: [] as string[],
        writes: false,
        // With no catalog there is nothing to be unknown against: only the
        // shape of the name itself is knowable, so a fetch failure must never
        // manufacture an "no repository declares it" claim.
        flag: !isRepositoryScriptGroupName(name)
          ? ("malformed" as const)
          : coverageKnown
            ? ("unknown" as const)
            : null,
      })),
  ].sort((a, b) => b.repoKeys.length - a.repoKeys.length || a.name.localeCompare(b.name));

  if (disabled) {
    return (
      <div className="flex flex-col gap-0.5">
        {selected.length === 0 ? (
          <div className="font-body text-[11px] text-neutral-500">No groups selected.</div>
        ) : (
          selected.map((name) => {
            const group = declared.get(name);
            return (
              <div
                key={name}
                className="flex items-center gap-2 font-mono text-[11px] text-neutral-700"
              >
                <span title={name} className="truncate">
                  {name}
                </span>
                {coverageKnown && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-500">
                    {group?.repoKeys.length ?? 0}/{allRepositories.length}{" "}
                    {pinned ? "pinned " : ""}repos
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    );
  }

  const malformed = rows.filter((row) => row.flag === "malformed");
  const unknown = rows.filter((row) => row.flag === "unknown");
  // One line for every partially covered group rather than a box each: a
  // heterogeneous tenant makes partial coverage the norm, and a stack of
  // identical boxes is what stops being read.
  const partial = catalog
    ? rows.filter(
        (row) =>
          row.flag === null &&
          selected.includes(row.name) &&
          row.repoKeys.length < allRepositories.length,
      )
    : [];

  return (
    <div className="flex flex-col gap-1.5">
      <ScriptCatalogStatus state={state} onReload={onReload} />
      {catalog !== null && catalog.groups.length === 0 && (
        <NoScriptsInScope pinned={catalog.pinned} />
      )}
      {rows.length > 0 && (
        <div className="flex max-h-[240px] flex-col gap-1 overflow-y-auto">
          {rows.map((row) => (
            <ScriptGroupRow
              key={row.name}
              row={row}
              allRepositories={allRepositories}
              coverageKnown={coverageKnown}
              pinned={pinned}
              checked={selected.includes(row.name)}
              onToggle={(checked) =>
                onChange(
                  checked
                    ? [...new Set([...selected, row.name])]
                    : selected.filter((name) => name !== row.name),
                )
              }
            />
          ))}
        </div>
      )}
      <AddScriptGroupName onAdd={(name) => onChange([...new Set([...selected, name])])} />
      {malformed.map((row) => (
        <div
          key={`malformed:${row.name}`}
          className="rounded-xs border border-red-200 bg-red-50 px-2 py-1 font-body text-[11px] leading-[1.4] text-red-700"
        >
          &quot;{row.name}&quot; is not a valid group name: {REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE}.
          Remove it before saving.
        </div>
      ))}
      {unknown.map((row) => (
        <div
          key={`unknown:${row.name}`}
          className="rounded-xs border border-amber-300 bg-amber-50 px-2 py-1 font-body text-[11px] leading-[1.4] text-amber-800"
        >
          No repository declares &quot;{row.name}&quot;.{" "}
          {block === "run_scripts"
            ? "This block will report it as not_run and allPassed will be false."
            : "This block will run nothing for it and still report outcome: passed."}
        </div>
      ))}
      {partial.length > 0 && (
        <div className="rounded-xs border border-neutral-200 bg-app-bg px-2 py-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          {partial.map((row) => row.name).join(", ")}: not declared by every repository in scope;
          they run nothing there. The block can still report{" "}
          {block === "run_scripts" ? "allPassed" : "passed"}.
        </div>
      )}
    </div>
  );
}

/** The gate block configures nothing here: what it requires lives entirely in
 *  Repository scripts. Showing the resolved selection is the whole point, since
 *  "checks are configured elsewhere" told an author nothing about what would
 *  actually run. */
export function GateSelectionField() {
  const { state, reload } = useScriptGroupCatalog();
  return (
    <ConfigField label="Gate selection">
      <GateSelectionList state={state} onReload={reload} />
    </ConfigField>
  );
}

/** run_scripts has one selection mode and no commands, so its Groups field is
 *  the picker and nothing else. An empty selection clears the param: the block
 *  has no second meaning for it, and Save blocks on it either way. */
export function RunScriptsGroupsField({
  node,
  disabled,
  onChange,
}: {
  node: FlowNodeDef;
  disabled: boolean;
  onChange: ConfigChange;
}) {
  const { state, reload } = useScriptGroupCatalog();
  return (
    <ConfigField label="Groups">
      <ScriptGroupsPicker
        block="run_scripts"
        selected={arr(node.params.groups)}
        state={state}
        onReload={reload}
        disabled={disabled}
        onChange={(next) => onChange("params.groups", next.length > 0 ? next : undefined)}
      />
    </ConfigField>
  );
}

const selectionRadioCls =
  "flex items-center gap-1.5 font-mono text-[10px] tracking-[0.04em] text-neutral-700";

/**
 * run_checks resolves its groups two ways and the params never said which: an
 * absent groups list means "whatever the publication gate requires", a named
 * list means an explicit, report-only selection.
 *
 * The mode is explicit UI state, seeded from params on mount and moved only by
 * the radio. Deriving it from "are any groups picked" made unchecking the last
 * box silently re-arm the gate, which is a different block, and made the radio
 * destroy a selection on a round trip. Sticky mode costs one held value and a
 * save issue for the empty Named state; the alternative cost correctness.
 */
export function RunChecksGroupsField({
  node,
  disabled,
  onChange,
}: {
  node: FlowNodeDef;
  disabled: boolean;
  onChange: ConfigChange;
}) {
  const { state, reload } = useScriptGroupCatalog();
  const selected = arr(node.params.groups);
  const commands = arr(node.params.commands);
  const [mode, setMode] = useState<"gate" | "named">(() =>
    Array.isArray(node.params.groups) ? "named" : "gate",
  );
  // What Named held before the author looked at the gate, so switching back is
  // a round trip and not a deletion.
  const [lastNamed, setLastNamed] = useState<string[]>(() => arr(node.params.groups));
  // Explicit commands win over every group selection at run time, so while any
  // are set neither mode describes what this block does. Dimming the whole
  // selection is the only honest state, and a viewer who cannot edit needs to
  // read that same truth.
  const commandsRule = commands.length > 0;
  const named = mode === "named";

  function selectGroups(next: string[]) {
    setLastNamed(next);
    // Written even when empty: the picker showing nothing checked and the
    // params still naming a group would be a lie, and the empty array is what
    // nodeSaveIssues reads to block Save on a Named block that picks nothing.
    onChange("params.groups", next);
  }

  return (
    <ConfigField label="Groups">
      <div
        className={
          commandsRule
            ? "pointer-events-none flex flex-col gap-1.5 opacity-40"
            : "flex flex-col gap-1.5"
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className={catalogLabelCls}>Selection:</span>
          <label className={selectionRadioCls}>
            <input
              type="radio"
              name={`${node.id}:groups-selection`}
              checked={!named}
              disabled={disabled || commandsRule}
              onChange={() => {
                setLastNamed(selected);
                setMode("gate");
                // Passing undefined deletes the optional groups parameter.
                // eslint-disable-next-line unicorn/no-useless-undefined -- Clear groups to select the default gate.
                onChange("params.groups", undefined);
              }}
              className="w-3 h-3 accent-mariner"
            />
            Gate groups (default)
          </label>
          <label className={selectionRadioCls}>
            <input
              type="radio"
              name={`${node.id}:groups-selection`}
              checked={named}
              disabled={disabled || commandsRule}
              onChange={() => {
                setMode("named");
                onChange("params.groups", lastNamed);
              }}
              className="w-3 h-3 accent-mariner"
            />
            Named groups
          </label>
        </div>
        {named ? (
          <>
            <ScriptGroupsPicker
              block="run_checks"
              selected={selected}
              state={state}
              onReload={reload}
              disabled={disabled || commandsRule}
              onChange={selectGroups}
            />
            {selected.length === 0 && !disabled && !commandsRule && (
              <div className="rounded-xs border border-red-200 bg-red-50 px-2 py-1 font-body text-[11px] leading-[1.4] text-red-700">
                No groups selected. Pick at least one, or switch back to Gate groups.
              </div>
            )}
            <div className="font-body text-[11px] leading-[1.4] text-neutral-600">
              A named selection is report-only and does not record the publication gate.
            </div>
          </>
        ) : (
          <GateSelectionList state={state} onReload={reload} />
        )}
      </div>
      {commandsRule && !disabled && (
        <button
          type="button"
          onClick={() => {
            // Passing undefined deletes the optional commands parameter.
            // eslint-disable-next-line unicorn/no-useless-undefined -- Clear commands to select groups.
            onChange("params.commands", undefined);
          }}
          className="appearance-none self-start rounded-xs border border-neutral-300 bg-white px-1.5 py-[3px] font-mono text-[10px] text-neutral-700 hover:bg-app-bg"
        >
          Clear commands to select groups
        </button>
      )}
    </ConfigField>
  );
}
