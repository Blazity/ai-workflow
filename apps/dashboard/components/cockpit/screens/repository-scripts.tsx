"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { expandGroupCommands, findExtendsCycle, sortedGroupNames } from "@shared/contracts";
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
  RepoScriptsExpandedCommand,
} from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";
import { Listbox } from "@/components/cockpit/listbox";

/** Shared wording between GateGroupsEditor (after the fact) and the group
 *  delete site (before the fact), so a user sees the exact same phrase. */
const GATING_ALL_GROUPS_NOTE = "Now gating on all groups.";

/** Said before the click on both destructive controls, matching the sentence
 *  GroupCard already shows while a group is being renamed. */
const GROUP_REMOVAL_NOTE =
  "Workflow blocks that name this group will not follow the removal and will report not_run.";

const REPOSITORY_REMOVAL_NOTE =
  "Removes this repository along with all its groups, setup commands and env settings.";

/** Saving is not scoped to runs that start later, so the Save control says so
 *  where the click happens rather than leaving it to be discovered. */
const SAVE_SCOPE_NOTE =
  "Applies to every run that reaches the gate after saving, including runs already in progress. Recorded gate results are keyed to this configuration and will be re-run.";

/** The worker's operator allowlist (pre-pr-checks/runner.ts
 *  PRE_PR_ALLOWED_ENV_VAR). Named here so the note can tell an operator the
 *  exact variable to edit. */
const ALLOWED_ENV_VAR = "PRE_PR_CHECKS_ALLOWED_ENV";

/** For a name that is not in the saved configuration: the PUT refuses the whole
 *  config over it, so this blocks Save. */
const NOT_ALLOWLISTED_NOTE =
  `Not allowlisted on this worker. Saving this configuration will be rejected. ` +
  `Add it to ${ALLOWED_ENV_VAR} and redeploy the worker, or remove the name.`;

/** For a name that IS in the saved configuration: it is already stored, so the
 *  damage is to the runs, not to the save. */
const NOT_FORWARDED_NOTE =
  `Not forwarded by this deployment. Every run for this repository will fail before any command ` +
  `runs. Add it to ${ALLOWED_ENV_VAR} and redeploy the worker.`;

/** The worker's compiled per-command default (pre-pr-checks/runner.ts
 *  DEFAULT_COMMAND_TIMEOUT_MINUTES). A deployment can move it with
 *  PRE_PR_COMMAND_TIMEOUT_MINUTES, which this screen cannot read, so the copy
 *  names that variable instead of promising the number is final. */
const DEFAULT_COMMAND_TIMEOUT_MINUTES = 10;

/** The single group a legacy flat command list is normalized to at the engine
 *  boundary (pre-pr-checks/config.ts, runner.ts LEGACY_GROUP_NAME). */
const LEGACY_GROUP_NAME = "checks";

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

/** The three secondary sections carry their own problem line while collapsed,
 *  so an error inside one never hides behind its header. Split out of
 *  firstRepoIssue rather than restated, so the row and the Save blocker cannot
 *  word the same problem differently. */
function firstSetupIssue(repo: PrePrCheckRepositoryConfig): string | null {
  return (repo.setup ?? []).some((c) => !nonBlank(c)) ? "empty setup command" : null;
}

/**
 * What this deployment forwards, and what this repository was already saved
 * with. The two together are what makes an off-allowlist name either a Save
 * blocker or a warning, and they are never the same thing:
 *
 *  - a name the saved config does NOT carry blocks Save, because the PUT
 *    refuses the whole configuration over it (pre-pr-checks.put.ts,
 *    describeDisallowedEnvNames), so letting the button through would buy a
 *    400 and nothing else;
 *  - a name the saved config DOES carry is the allowlist-shrank case. It is
 *    already stored, so blocking Save on it would trap an operator in an editor
 *    that cannot save anything at all, including the edit that removes the
 *    name. It warns instead, about the runs that really are failing.
 *
 * `allowed: undefined` is a worker that never reported an allowlist, which is
 * not an empty one: it says nothing either way, so neither branch fires.
 */
interface EnvPolicy {
  allowed: string[] | undefined;
  saved: string[];
}

function envPolicyFor(
  repo: PrePrCheckRepositoryConfig,
  savedConfig: PrePrCheckConfig,
  allowedEnv: string[] | undefined,
): EnvPolicy {
  const saved = savedConfig.repositories.find((r) => repoKey(r) === repoKey(repo));
  return { allowed: allowedEnv, saved: saved?.env ?? [] };
}

/** A well formed name this deployment does not forward. A malformed one is not
 *  this function's problem: it has its own error, and the allowlist could not
 *  contain it anyway. */
function offAllowlist(name: string, policy: EnvPolicy): boolean {
  return (
    policy.allowed !== undefined &&
    nonBlank(name) &&
    isValidEnvName(name) &&
    !policy.allowed.includes(name)
  );
}

function firstEnvIssue(repo: PrePrCheckRepositoryConfig, policy: EnvPolicy): string | null {
  const badEnv = (repo.env ?? []).find((n) => !isValidEnvName(n));
  if (badEnv !== undefined) return `invalid env var name "${badEnv}"`;
  const rejected = (repo.env ?? []).find(
    (name) => offAllowlist(name, policy) && !policy.saved.includes(name),
  );
  if (rejected !== undefined) {
    return `env var ${rejected} is not allowlisted on this worker; the save will be rejected`;
  }
  return null;
}

/** Not a Save blocker: this name is already stored, so the configuration is not
 *  what is broken. What is broken is every run that reaches it. Kept next to
 *  firstEnvIssue so the collapsed section can carry it the same way it carries
 *  a real error, one severity down. */
function firstEnvWarning(repo: PrePrCheckRepositoryConfig, policy: EnvPolicy): string | null {
  const missing = (repo.env ?? []).find(
    (name) => offAllowlist(name, policy) && policy.saved.includes(name),
  );
  return missing === undefined ? null : `"${missing}" is not forwarded by this deployment.`;
}

function firstTimeoutIssue(repo: PrePrCheckRepositoryConfig): string | null {
  if (repo.commandTimeoutMinutes === undefined) return null;
  return isPositiveInt(repo.commandTimeoutMinutes)
    ? null
    : "per-command timeout must be a whole number of minutes, 1 or more";
}

function firstRepoIssue(repo: PrePrCheckRepositoryConfig, policy: EnvPolicy): string | null {
  const sectionIssue =
    firstSetupIssue(repo) ?? firstEnvIssue(repo, policy) ?? firstTimeoutIssue(repo);
  if (sectionIssue) return sectionIssue;

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
 *  A rename commits on blur or Enter, never per keystroke, so every draft is
 *  pending for one of three reasons. It duplicates a sibling, it is not a
 *  legal group name, or it is simply not applied yet. Committing per keystroke
 *  was worse than a cosmetic wart: renaming "lint" to "test" committed "t",
 *  "te" and "tes" for real along the way, so a final name that collided left
 *  the group permanently named "tes", with gateGroups and every extends
 *  reference rewritten to match. */
interface PendingGroupNameDraft {
  repoPath: string;
  attempted: string;
  reason: "duplicate" | "invalid" | "uncommitted";
}

function firstConfigIssue(
  config: PrePrCheckConfig,
  /** The last configuration loaded from the server, which decides whether an
   *  off-allowlist env name blocks Save or only warns (see EnvPolicy). */
  savedConfig: PrePrCheckConfig,
  allowedEnv: string[] | undefined,
  draft?: PendingGroupNameDraft | null,
): string | null {
  if (draft) {
    if (draft.reason === "duplicate") {
      return `${draft.repoPath}: group name "${draft.attempted}" duplicates an existing group`;
    }
    if (draft.reason === "invalid") {
      return `${draft.repoPath}: group name "${draft.attempted}" is invalid (${GROUP_NAME_RULE})`;
    }
    return `${draft.repoPath}: group name "${draft.attempted}" is not applied yet; press Enter or click outside the field`;
  }
  if (config.batchTimeoutMinutes !== undefined && !isPositiveInt(config.batchTimeoutMinutes)) {
    return "batch timeout must be a whole number of minutes, 1 or more";
  }
  // The same path is allowed once per provider, and a message naming only the
  // path would then point at two cards.
  const paths = config.repositories.map((r) => r.repoPath);
  for (const repo of config.repositories) {
    const issue = firstRepoIssue(repo, envPolicyFor(repo, savedConfig, allowedEnv));
    if (!issue) continue;
    const label =
      paths.indexOf(repo.repoPath) !== paths.lastIndexOf(repo.repoPath)
        ? `${repo.provider}:${repo.repoPath}`
        : repo.repoPath;
    return `${label}: ${issue}`;
  }
  return null;
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

/** The accordion key of a repository card, identical to its React key. Never
 *  the path alone: the same path is allowed once per provider. */
function repoKey(repo: { provider: string; repoPath: string }): string {
  return `${repo.provider}:${repo.repoPath}`;
}

/** Editor state that outlives a card is keyed by repository and name, never by
 *  position. A save comes back with the groups in whatever key order the
 *  response carries, and a restore can carry an order the server never
 *  normalized, so a positional key would quietly start pointing at another
 *  group. The separator is a NUL because no group name or repository path can
 *  contain one. */
const UI_KEY_SEP = "\u0000";
function uiKey(repo: string, id: string): string {
  return `${repo}${UI_KEY_SEP}${id}`;
}

function withKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return set.has(key) ? set : new Set(set).add(key);
}

function withoutKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

function withRenamedKey(
  set: ReadonlySet<string>,
  from: string,
  to: string,
): ReadonlySet<string> {
  if (!set.has(from)) return set;
  const next = new Set(set);
  next.delete(from);
  next.add(to);
  return next;
}

/** The editor state that must survive a card closing: which cards and sections
 *  are open, and which groups an add put into the gate selection. Held at the
 *  screen, so closing a repository (or a save that reorders its groups) does
 *  not throw it away, and threaded down as one object rather than six props. */
interface EditorUi {
  isOpen(key: string): boolean;
  toggle(key: string): void;
  reveal(key: string): void;
  /** Moves both the open flag and the auto-gated mark of a renamed group. */
  renameKey(from: string, to: string): void;
  autoGatedNames(repo: string): string[];
  markAutoGated(key: string): void;
  clearAutoGated(key: string): void;
}

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What the gate actually runs for this repository: the explicit selection, or
 *  every group when there is none. */
function gateSummary(repo: PrePrCheckRepositoryConfig): string {
  return repo.gateGroups === undefined ? "all groups" : repo.gateGroups.join(", ");
}

function runsAtGate(repo: PrePrCheckRepositoryConfig, name: string): boolean {
  return repo.gateGroups === undefined || repo.gateGroups.includes(name);
}

/** The one-line stand-in for a collapsed repository card. */
function repoSummary(repo: PrePrCheckRepositoryConfig): string {
  const groupNames = Object.keys(repo.groups ?? {});
  const segments: string[] = [];
  if (groupNames.length > 0) {
    segments.push(countLabel(groupNames.length, "group"));
    segments.push(`gate: ${gateSummary(repo)}`);
  } else {
    segments.push(countLabel((repo.commands ?? []).length, "command"));
  }
  const setup = (repo.setup ?? []).length;
  if (setup > 0) segments.push(`setup ${setup}`);
  const env = (repo.env ?? []).length;
  if (env > 0) segments.push(`env ${env}`);
  return segments.join(" · ");
}

/** The one-line stand-in for a collapsed group card, minus the name, which the
 *  row renders on its own so it keeps the weight it has when expanded. The
 *  gate chip is a sibling element, not part of this string. */
function groupSummaryTail(group: PrePrCheckGroupConfig): string {
  const extendsList = group.extends ?? [];
  return [
    countLabel((group.commands ?? []).length, "command"),
    `extends: ${extendsList.length > 0 ? extendsList.join(", ") : "(none)"}`,
  ].join(" · ");
}

/** The problem a collapsed group card has to keep visible. A cycle first: it
 *  is the one a user cannot see from the card's own contents. */
function groupRowProblem(
  name: string,
  group: PrePrCheckGroupConfig,
  cyclePath: string[] | null,
): string | null {
  if (cyclePath) return `Part of an extends cycle: ${cyclePath.join(" -> ")}.`;
  if (!isValidGroupName(name)) return "Invalid group name.";
  const issue = firstGroupIssue(group);
  return issue === null ? null : `${issue.charAt(0).toUpperCase()}${issue.slice(1)}.`;
}

/** A collapsed row must never swallow an error, so every one of them renders
 *  this when it has a problem to report. */
function ProblemLine({ text }: { text: string }) {
  return (
    <div className="mt-[3px] flex items-center gap-[6px] font-body text-[11px] text-red-600">
      <span aria-hidden className="inline-block w-[6px] h-[6px] rounded-full bg-red-600" />
      {text}
    </div>
  );
}

/** A problem that does not block Save but changes what a run will do, so it
 *  cannot be left to a tooltip. Same shape as ProblemLine, one severity down. */
function WarningLine({ text }: { text: string }) {
  return (
    <div className="mt-[3px] flex items-start gap-[6px] font-body text-[11px] text-burnt-orange">
      <span aria-hidden className="mt-[5px] inline-block w-[6px] h-[6px] shrink-0 rounded-full bg-burnt-orange" />
      <span>{text}</span>
    </div>
  );
}

function GateChip({ atGate }: { atGate: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-[3px] px-[6px] py-[2px] font-mono text-[10px] ${
        atGate ? "bg-mariner text-white" : "bg-app-bg text-neutral-600"
      }`}
    >
      {atGate ? "runs at gate" : "not at gate"}
    </span>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <span aria-hidden className="font-mono text-[10px] text-neutral-400">
      {open ? "▾" : "▸"}
    </span>
  );
}

/** Setup, Env vars and Per-command timeout: three sections a repository needs
 *  once and then never looks at again, so they sit behind a counted header. */
function SecondaryRow({
  label,
  problem,
  warning,
  open,
  onToggle,
  children,
}: {
  label: string;
  problem: string | null;
  /** A collapsed section must not swallow a warning either, but a warning is
   *  never louder than the error it sits behind. */
  warning?: string | null;
  /** Owned by the screen (see EditorUi), so closing and reopening the
   *  repository brings the same sections back open. */
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 border-t border-neutral-200 pt-2">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 appearance-none border-none bg-transparent px-0 text-left font-body text-[12px] font-semibold text-neutral-800 cursor-pointer"
      >
        <Caret open={open} />
        {label}
      </button>
      {!open && problem && <ProblemLine text={problem} />}
      {!open && !problem && warning && <WarningLine text={warning} />}
      {open && <div className="mt-[6px]">{children}</div>}
    </div>
  );
}

/** A collapsed-by-default preview, opened through the screen's own key set so
 *  it survives its card closing exactly like the cards themselves do. */
function PreviewDisclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-2 appearance-none border-none bg-transparent px-0 text-left font-body text-[11px] text-mariner cursor-pointer"
      >
        <Caret open={open} />
        {label}
      </button>
      {open && <div className="mt-[4px] ml-4">{children}</div>}
    </div>
  );
}

/** expandGroupCommands takes `commands` as a required array; the stored shape
 *  leaves it out entirely for a group that only extends others. */
function withCommandArrays(
  groups: Record<string, PrePrCheckGroupConfig>,
): Record<string, { commands: string[]; extends?: string[] }> {
  const out: Record<string, { commands: string[]; extends?: string[] }> = {};
  for (const [name, group] of Object.entries(groups)) {
    out[name] = { commands: group.commands ?? [], extends: group.extends };
  }
  return out;
}

/** What the publication gate will run for this repository: the explicit
 *  selection, or every group in the worker's own default order (the
 *  `repo.gateGroups ?? sortedGroupNames(repo.groups)` of
 *  pre-pr-checks/config.ts). A legacy flat entry is previewed the way the
 *  engine normalizes it, as a single "checks" group. */
function gatePlan(repo: PrePrCheckRepositoryConfig): {
  groups: Record<string, PrePrCheckGroupConfig>;
  names: string[];
} {
  const groups = repo.groups ?? {};
  if (Object.keys(groups).length === 0) {
    return {
      groups: { [LEGACY_GROUP_NAME]: { commands: repo.commands ?? [] } },
      names: [LEGACY_GROUP_NAME],
    };
  }
  return { groups, names: repo.gateGroups ?? sortedGroupNames(groups) };
}

/** The exact command list the worker will run, in order, each row attributed to
 *  the group that DECLARES the command rather than the one whose expansion
 *  reached it. Computed by the shared expansion the runner itself uses, because
 *  a preview from a second implementation is a promise about execution that
 *  nothing keeps.
 *
 *  A draft being typed can be cyclic or reference a group that does not exist,
 *  and the expansion throws on both, so its message replaces the list rather
 *  than taking the screen down. */
function RunOrderPreview({
  groups,
  groupNames,
}: {
  groups: Record<string, PrePrCheckGroupConfig>;
  groupNames: string[];
}) {
  let expanded: RepoScriptsExpandedCommand[];
  try {
    expanded = expandGroupCommands({ groups: withCommandArrays(groups) }, groupNames);
  } catch (error) {
    return (
      <div className="font-body text-[11px] text-red-600">
        {error instanceof Error ? error.message : "this draft cannot be expanded"}
      </div>
    );
  }
  if (expanded.length === 0) {
    return <div className="font-body text-[11px] text-neutral-500">No commands to run.</div>;
  }
  return (
    <ol className="m-0 list-none p-0">
      {expanded.map((row, i) => (
        <li key={`${row.group}:${row.command}`} className="font-mono text-[11px] text-neutral-700">
          {i + 1}. {nonBlank(row.command) ? row.command : "(blank)"}{" "}
          <span className="text-neutral-400">[{row.group}]</span>
        </li>
      ))}
    </ol>
  );
}

/** Whether the catalog says this configured path exists.
 *
 *  `null` is "nobody asked, or nobody could answer": the catalog is fetched
 *  lazily by the picker, and a provider that failed to list (a stale GitLab
 *  token, 401 on the metadata call) returns nothing at all. Calling every one
 *  of that provider's repositories missing would be the loudest possible lie. */
function catalogVerdict(
  catalog: RepositoriesResponse | null,
  repo: PrePrCheckRepositoryConfig,
): boolean | null {
  if (catalog === null) return null;
  const provider = catalog.providers.find((p) => p.provider === repo.provider);
  if (provider === undefined || provider.status !== "ready") return null;
  return catalog.repositories.some(
    (o) => o.provider === repo.provider && o.repoPath === repo.repoPath,
  );
}

/** A repository the user just added and has not typed anything into yet. Every
 *  SAVED entry carries at least one non-blank command (Save blocks otherwise),
 *  so "not in the saved config and not one non-blank command anywhere" can only
 *  ever describe a fresh seed. It buys the new card a neutral hint instead of
 *  the red errors an empty group would otherwise be born with, and blanking a
 *  configured repository's only command still reports normally. */
function isUntouchedNewEntry(
  repo: PrePrCheckRepositoryConfig,
  savedKeys: ReadonlySet<string>,
): boolean {
  if (savedKeys.has(repoKey(repo))) return false;
  const groups = repo.groups ?? {};
  const names = Object.keys(groups);
  if (names.length === 0) return false;
  return names.every(
    (name) =>
      (groups[name].extends ?? []).length === 0 &&
      (groups[name].commands ?? []).every((command) => !nonBlank(command)),
  );
}

/** A DOM id for the repository card, so the Save blocker can scroll to the card
 *  it names. Derived from repoKey, which is already unique per card. */
function repoDomId(key: string): string {
  return `repo-card-${key.replace(/[^A-Za-z0-9]+/g, "-")}`;
}

/** The one field that belongs to no repository, and the only place the Save
 *  blocker can point at when the batch timeout is what is wrong. */
const BATCH_TIMEOUT_DOM_ID = "batch-timeout-field";

/** The open key of a repository's secondary section. Namespaced, because a
 *  section id and a group name share one key space: "setup", "env" and
 *  "timeout" are all legal group names (see GROUP_NAME_PATTERN), and a group
 *  called "setup" used to open and close the Setup section with it. The colon
 *  is outside the group-name alphabet, so nothing can collide again. Group
 *  cards keep bare names. */
function sectionKeyOf(repoKeyValue: string, id: string): string {
  return uiKey(repoKeyValue, `sec:${id}`);
}

/** Best effort, and only that: the test renderer has no document, and a card
 *  that is not on screen yet has no element until React has painted it. */
function scrollIntoView(domId: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(domId)?.scrollIntoView({ block: "center" });
}

/**
 * Unsaved edits on this screen, readable by the cockpit shell before it
 * navigates. The shell renders a screen as opaque `children` (the rendered
 * output of a server component), so there is no provider boundary between the
 * two to thread state through, and `router.push` never fires `beforeunload`.
 * A module-level single slot: only one Repository scripts screen is ever
 * mounted, and it clears the flag when it unmounts.
 */
let unsavedRepositoryScripts = false;

export function hasUnsavedRepositoryScripts(): boolean {
  return unsavedRepositoryScripts;
}

/** Asked by the shell before it navigates away from unsaved edits. */
export const DISCARD_UNSAVED_PROMPT = "Discard unsaved changes?";

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
  // The version the draft in the editor is built on, and the concurrency token
  // Save sends. It moves only when the editor content itself is rebased (a save
  // or restore that came back, a discard onto a newer version, a live refresh
  // adopted while nothing was edited), never because a refreshed server render
  // merely shows a newer version while an edit is in progress: a token that
  // followed the poll would let the save pass and overwrite what it had seen.
  const [base, setBase] = useState<PrePrCheckConfigVersion | null>(initial.versions[0] ?? null);
  // Set right before a reload this screen itself asked for, so the unsaved
  // changes guard does not ask a second time about a discard already confirmed.
  const leaving = useRef(false);
  const [confirmLoadLatest, setConfirmLoadLatest] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // What the last Preview click did, reported on the History row itself so it
  // is visible whether or not the load changed anything.
  const [previewNote, setPreviewNote] = useState<{
    version: number;
    identical: boolean;
  } | null>(null);
  // A save the server refused because someone else saved first. Kept separate
  // from `error`: it is not a failure to explain, it is a newer version to go
  // and read, and the edit in the editor is still worth keeping.
  const [conflict, setConflict] = useState<{ latestVersion: number | null } | null>(null);
  // Bumped by Discard to remount the repository cards, which is what actually
  // clears the state they own: a half-typed rename, an armed remove confirm.
  const [editorEpoch, setEditorEpoch] = useState(0);
  // The repository catalog. Fetched once per mount when there is at least one
  // configured repository, because the "not in the catalog" badge is exactly
  // the thing nobody thinks to go looking for. The endpoint is cached for 60s
  // on the worker, and the picker reuses whatever landed here.
  const [catalog, setCatalog] = useState<RepositoriesResponse | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const catalogRequested = useRef(false);
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
  // Which repository card is expanded: one at a time, because a configured
  // fleet is several screens of always-open cards otherwise. `undefined` is
  // "the user has not chosen yet", which auto-expands a lone repository;
  // removing a repository resets to it, so the survivor of a two-repo config
  // opens on its own.
  const [openRepo, setOpenRepo] = useState<string | null | undefined>(undefined);
  // Group cards and secondary sections that are open, and groups the last add
  // put into the gate selection. Both keyed by repository and name (see
  // uiKey), both here rather than inside the cards, so closing a repository or
  // saving does not reset them.
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [autoGatedKeys, setAutoGatedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const savedConfig = base?.config ?? emptyConfig();
  const baseVersion = base?.version ?? 0;
  // A version History holds that the editor is not built on yet: what the
  // conflict banner offers to load without a page reload.
  const latestKnown =
    versions[0] !== undefined && versions[0].version > baseVersion ? versions[0] : undefined;
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const issue = firstConfigIssue(config, savedConfig, initial.allowedEnv, groupDraft);
  const valid = issue === null;
  const savedKeys = new Set(savedConfig.repositories.map(repoKey));
  const openRepoKey =
    openRepo === undefined
      ? config.repositories.length === 1
        ? repoKey(config.repositories[0])
        : null
      : openRepo;

  const ui: EditorUi = {
    isOpen: (key) => openKeys.has(key),
    toggle: (key) =>
      setOpenKeys((prev) => (prev.has(key) ? withoutKey(prev, key) : withKey(prev, key))),
    reveal: (key) => setOpenKeys((prev) => withKey(prev, key)),
    renameKey: (from, to) => {
      setOpenKeys((prev) => withRenamedKey(prev, from, to));
      setAutoGatedKeys((prev) => withRenamedKey(prev, from, to));
    },
    autoGatedNames: (repo) => {
      const prefix = `${repo}${UI_KEY_SEP}`;
      return [...autoGatedKeys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
    markAutoGated: (key) => setAutoGatedKeys((prev) => withKey(prev, key)),
    clearAutoGated: (key) => setAutoGatedKeys((prev) => withoutKey(prev, key)),
  };

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

  /** The catalog the picker also uses. Once per mount, and never twice: an
   *  operator opening the picker after this has landed gets it instantly. */
  async function loadCatalog() {
    if (catalogRequested.current) return;
    catalogRequested.current = true;
    try {
      const res = await fetch("/api/repositories");
      if (!res.ok) throw new Error("failed");
      setCatalog((await res.json()) as RepositoriesResponse);
    } catch {
      setCatalogFailed(true);
    }
  }

  // A configured repository the catalog does not list runs nothing, forever,
  // and says so nowhere else. Waiting for someone to open the Add repository
  // picker made the badge depend on the one action a settled fleet never takes.
  useEffect(() => {
    if (initial.current?.config.repositories.length) void loadCatalog();
    // Once per mount: loadCatalog latches on its own ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // History is rendered from state so a save can prepend to it without a round
  // trip, which means a server render carrying someone else's newer version has
  // to be adopted, or this list is stale for the rest of the session. Never
  // backwards: our own just-saved version outranks a prop that predates it.
  //
  // The editor content follows only while nothing is edited. With an edit in
  // progress the newer version raises the conflict banner, and the draft, its
  // token and the banner all stay put until the person decides: the cockpit's
  // live poll refreshes this render on a timer, so anything else here would
  // hand a stale draft a fresh token a few seconds after a refusal.
  useEffect(() => {
    const newest = initial.versions[0];
    const newestVersion = newest?.version ?? 0;
    setVersions((prev) => (newestVersion >= (prev[0]?.version ?? 0) ? initial.versions : prev));
    if (newest === undefined || newestVersion <= baseVersion) return;
    if (dirty) {
      setConflict({ latestVersion: newestVersion });
    } else {
      applyVersion(newest);
    }
    // A changed server render is the event; everything else is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.versions]);

  // A closed tab loses whatever isn't saved yet. Back and forward are NOT
  // covered by this event (a same-document history move never fires it), which
  // is what the popstate guard below is for.
  useEffect(() => {
    if (!dirty) return;
    if (typeof window === "undefined") return;
    // Captured once: a cleanup has to unsubscribe from the same object it
    // subscribed to, whatever the global points at by then.
    const w = window;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // A reload the conflict banner asked for has already been confirmed.
      if (leaving.current) return;
      e.preventDefault();
      // Legacy prompt trigger, still required by Chrome/Edge before 119. An
      // empty string does not count as set, so this has to be truthy.
      e.returnValue = true;
    };
    w.addEventListener("beforeunload", onBeforeUnload);
    return () => w.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // The cockpit navigates with router.push, which beforeunload never sees, so
  // the shell asks this module instead (see hasUnsavedRepositoryScripts).
  useEffect(() => {
    unsavedRepositoryScripts = dirty;
    return () => {
      unsavedRepositoryScripts = false;
    };
  }, [dirty]);

  // Browser Back is the third exit, and the quietest one: no unload, no
  // router.push, just a same-document history move. The guard is the standard
  // sentinel: while there are unsaved edits an extra entry sits on the stack,
  // Back lands on it instead of leaving, and the answer decides whether we
  // follow the user out or put the sentinel back. The sentinel outlives the
  // dirty state as one extra same-URL entry, which costs one more Back press
  // and is the reason it is never popped from a cleanup: doing that would
  // navigate someone who never asked to go anywhere.
  useEffect(() => {
    if (!dirty) return;
    if (typeof window === "undefined" || !window.history) return;
    const w = window;
    w.history.pushState({ repositoryScriptsGuard: true }, "");
    const onPopState = () => {
      if (typeof w.confirm === "function" && !w.confirm(DISCARD_UNSAVED_PROMPT)) {
        w.history.pushState({ repositoryScriptsGuard: true }, "");
        return;
      }
      // The sentinel has already been popped by this event, so one more step
      // back reaches the entry the person actually asked for.
      w.removeEventListener("popstate", onPopState);
      w.history.go(-1);
    };
    w.addEventListener("popstate", onPopState);
    return () => w.removeEventListener("popstate", onPopState);
  }, [dirty]);

  /** Makes `version` what the editor is built on: content, token and History
   *  together, so no two of them can disagree. Idempotent on History, because
   *  a version adopted from a server render is already listed there. */
  function applyVersion(version: PrePrCheckConfigVersion) {
    setVersions((prev) =>
      prev.some((v) => v.version === version.version) ? prev : [version, ...prev],
    );
    setBase(version);
    setConfig(structuredClone(version.config));
    // A save comes back with the same repositories, so the one being worked in
    // stays open; a restore can drop it, and then the choice goes back to
    // "not chosen yet" so a lone survivor auto-expands.
    setOpenRepo((prev) =>
      prev != null && version.config.repositories.some((r) => repoKey(r) === prev)
        ? prev
        : undefined,
    );
    // The auto-add note is about an unsaved edit; the version that just landed
    // has the selection in it.
    setAutoGatedKeys((prev) => (prev.size === 0 ? prev : new Set()));
    setPreviewNote(null);
    setConfirmDiscard(false);
    setConfirmLoadLatest(false);
    setConflict(null);
  }

  /** Loads an older version into the editor as an unsaved edit. It writes
   *  nothing on its own: the normal dirty state, the Save blocker and Save
   *  itself all apply, so a version can be read, adjusted and then saved
   *  forward instead of being restored blind. */
  function previewVersion(version: PrePrCheckConfigVersion) {
    // An older version identical to what is already in the editor changes
    // nothing, and a control that answers a click with no visible effect reads
    // as broken. Say so instead.
    if (JSON.stringify(version.config) === JSON.stringify(config)) {
      setPreviewNote({ version: version.version, identical: true });
      return;
    }
    if (
      dirty &&
      typeof window !== "undefined" &&
      typeof window.confirm === "function" &&
      !window.confirm("Discard unsaved changes and load this version into the editor?")
    ) {
      return;
    }
    setConfig(structuredClone(version.config));
    setOpenRepo((prev) =>
      prev != null && version.config.repositories.some((r) => repoKey(r) === prev)
        ? prev
        : undefined,
    );
    setAutoGatedKeys((prev) => (prev.size === 0 ? prev : new Set()));
    setPreviewNote({ version: version.version, identical: false });
    setConfirmDiscard(false);
  }

  /** Back to the config as it was last loaded from the server. Two steps, like
   *  every other destructive control on this screen. */
  function discard() {
    // A newer version learned of meanwhile (a live refresh, a refused save) is
    // what "as last saved" means by now, so the discard lands on it.
    if (latestKnown !== undefined) {
      applyVersion(latestKnown);
    } else {
      setConfig(structuredClone(savedConfig));
      setAutoGatedKeys((prev) => (prev.size === 0 ? prev : new Set()));
      setPreviewNote(null);
      setConfirmDiscard(false);
      setConflict(null);
    }
    // Everything the discarded edit left behind goes with it: the banner from a
    // save that failed, and the card-owned state a re-render cannot reach (a
    // rename typed but never committed, an armed remove confirm). Remounting
    // the cards is what clears the latter, and it also drops the pending-rename
    // report that would otherwise keep blocking Save from behind a field that
    // no longer holds anything.
    setError(null);
    setEditorEpoch((n) => n + 1);
  }

  // What the conflict banner can load: the newer version itself when History
  // holds it (a live refresh or the fetch after a refused save brought it), or
  // a page reload when it does not.
  const loadLatestLabel =
    latestKnown !== undefined
      ? `version ${latestKnown.version}`
      : "the newer version (reloads the page)";
  const conflictActionClass =
    "appearance-none border-none bg-transparent px-0 font-body text-[12px] font-semibold text-red-700 underline cursor-pointer";
  function loadLatest() {
    setConfirmLoadLatest(false);
    if (latestKnown !== undefined) {
      discard();
      return;
    }
    leaving.current = true;
    if (typeof window !== "undefined") window.location.reload();
  }

  /** After a refused save the newer version exists only as a number in the
   *  banner. Fetching the list puts it into History, where it can be previewed
   *  before anyone discards an edit for it, and lets the banner load it without
   *  a page reload. The editor content and its token are untouched: this reads
   *  what exists, it adopts nothing. */
  async function refreshHistory() {
    try {
      const res = await fetch("/api/pre-pr-checks");
      if (!res.ok) return;
      const latest = (await res.json()) as Partial<PrePrChecksResponse> | null;
      if (!Array.isArray(latest?.versions)) return;
      const fetched = latest.versions;
      setVersions((prev) =>
        (fetched[0]?.version ?? 0) >= (prev[0]?.version ?? 0) ? fetched : prev,
      );
    } catch {
      // The banner already says what happened; History just stays as it was.
    }
  }

  /** The Save blocker names a repository that may be collapsed, three cards
   *  down. Clicking it opens that repository and its offending group and
   *  scrolls the card into view, so the sentence is a way back to the problem
   *  rather than only a description of it. */
  function revealIssue() {
    const policyOf = (repo: PrePrCheckRepositoryConfig) =>
      envPolicyFor(repo, savedConfig, initial.allowedEnv);
    const target = groupDraft
      ? config.repositories.find((r) => r.repoPath === groupDraft.repoPath)
      : config.repositories.find((r) => firstRepoIssue(r, policyOf(r)) !== null);
    // The batch timeout belongs to no repository. It is still somewhere on a
    // page taller than the viewport, so the blocker still has to go to it.
    if (target === undefined) {
      scrollIntoView(BATCH_TIMEOUT_DOM_ID);
      return;
    }
    const key = repoKey(target);
    setOpenRepo(key);
    // A collapsed section hides its own error behind a header, so opening the
    // repository is not enough: the row that produced the issue has to open
    // too, or the blocker lands someone on a card that looks fine.
    const section = firstSetupIssue(target)
      ? "setup"
      : firstEnvIssue(target, policyOf(target))
        ? "env"
        : firstTimeoutIssue(target)
          ? "timeout"
          : null;
    const groups = target.groups ?? {};
    const offending = Object.keys(groups).find(
      (name) => !isValidGroupName(name) || firstGroupIssue(groups[name]) !== null,
    );
    if (section !== null) {
      setOpenKeys((prev) => withKey(prev, sectionKeyOf(key, section)));
    } else if (offending !== undefined) {
      setOpenKeys((prev) => withKey(prev, uiKey(key, offending)));
    }
    scrollIntoView(repoDomId(key));
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
        // The version this edit started from. The worker refuses the write when
        // a newer one exists, which is the only thing standing between two
        // operators and one of them silently overwriting the other.
        //
        // 0, never undefined, when nothing has ever been stored: absent means
        // "do not check" to the worker, so it is how a legacy dashboard saves,
        // and an empty store is exactly where two people both save a first
        // configuration and one of them loses it without being told.
        body: JSON.stringify({ config, baseVersion }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { latestVersion?: number } | null;
        setConflict({ latestVersion: body?.latestVersion ?? null });
        void refreshHistory();
        return;
      }
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
          Save is disabled: {issue}.{" "}
          <button
            onClick={revealIssue}
            className="appearance-none border-none bg-transparent px-0 font-body text-[11px] text-red-600 underline cursor-pointer"
          >
            Show me
          </button>
        </p>
      )}
      <p className="font-body text-[13px] text-neutral-600 mb-4">
        Setup commands run once per repository to provision a toolchain the sandbox does not ship.
        Named script groups then run for changed repositories after implementation and before
        branch push / PR creation. At the publication gate a repository runs every group by
        default, or only the groups you select.
      </p>
      {conflict && (
        <div className="mb-3 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700">
          {conflict.latestVersion === null
            ? "A newer version was saved by someone else while you were editing."
            : `Version ${conflict.latestVersion} was saved by someone else while you were editing.`}{" "}
          Your changes here stay until you load it, and loading it discards them.{" "}
          {confirmLoadLatest ? (
            <>
              Discard your changes and load {loadLatestLabel}?{" "}
              <button onClick={loadLatest} className={conflictActionClass}>
                Yes, discard and load
              </button>{" "}
              <button onClick={() => setConfirmLoadLatest(false)} className={conflictActionClass}>
                Keep editing
              </button>
            </>
          ) : (
            <button onClick={() => setConfirmLoadLatest(true)} className={conflictActionClass}>
              Load {loadLatestLabel}
            </button>
          )}
        </div>
      )}
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

      <div
        id={BATCH_TIMEOUT_DOM_ID}
        className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3 mb-3"
      >
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
          // The epoch remounts every card, which is how Discard clears the
          // state the cards own (a half-typed rename, an armed confirm).
          key={`${editorEpoch}:${repoKey(repo)}`}
          repo={repo}
          open={openRepoKey === repoKey(repo)}
          disabled={!canEdit}
          ui={ui}
          envPolicy={envPolicyFor(repo, savedConfig, initial.allowedEnv)}
          inCatalog={catalogVerdict(catalog, repo)}
          pristine={isUntouchedNewEntry(repo, savedKeys)}
          onToggle={() =>
            setOpenRepo(openRepoKey === repoKey(repo) ? null : repoKey(repo))
          }
          onChange={(next) => updateRepo(index, next)}
          onRemove={() => {
            // Only the removed repository gives up its open slot: removing a
            // third repository must leave the one the user is working in open.
            setOpenRepo((prev) => (prev === repoKey(repo) ? undefined : prev));
            setConfig((prev) => ({
              ...prev,
              repositories: prev.repositories.filter((_, i) => i !== index),
            }));
          }}
          onGroupDraft={reportGroupDraft}
        />
      ))}

      {canEdit && (
        <AddRepository
          configured={config.repositories}
          catalog={catalog}
          catalogFailed={catalogFailed}
          onOpen={loadCatalog}
          onAdd={(repo) => {
            // A repository added to a fleet would otherwise land collapsed,
            // with nothing to fill in on screen, and its lone group would land
            // collapsed behind a row that already reads as an error.
            setOpenRepo(repoKey(repo));
            ui.reveal(uiKey(repoKey(repo), "checks"));
            setConfig((prev) => ({
              ...prev,
              repositories: [
                ...prev.repositories,
                // No command row at all, rather than one blank row: a
                // repository nobody has typed into yet is not a mistake, and
                // being born with a red error taught nothing.
                { ...repo, groups: { checks: { commands: [] } } },
              ],
            }));
          }}
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
          {v.version === versions[0]?.version && (
            <span className="rounded-[3px] bg-mariner px-[6px] py-[2px] font-mono text-[10px] text-white">
              current
            </span>
          )}
          {previewNote?.version === v.version && (
            // On the row rather than only in the save bar: a preview that
            // changed nothing produces no unsaved edit, so the bar never
            // appears and the click looked like it did nothing at all.
            <span className="font-body text-[11px] text-neutral-600">
              {previewNote.identical
                ? `v${v.version} is identical to the current version`
                : "loaded into the editor"}
            </span>
          )}
          {canEdit && v.version !== versions[0]?.version && (
            <span className="ml-auto">
              {/* Loads the version into the editor as an unsaved edit: nothing
                  is written until Save, and the Save blocker still applies. */}
              <button
                onClick={() => previewVersion(v)}
                className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer mr-3"
              >
                Preview
              </button>
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

      {canEdit && dirty && (
        // Sticky rather than a second header block: the cards are taller than
        // the viewport, and the Save button being three screens up is how an
        // edit gets left unsaved.
        <div className="sticky bottom-0 -mx-6 mt-6 border-t border-neutral-200 bg-panel px-6 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-body text-[12px] font-semibold text-neutral-900">
              Unsaved changes
            </span>
            {previewNote !== null && !previewNote.identical && (
              <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
                loaded from v{previewNote.version}
              </span>
            )}
            {issue && (
              <button
                onClick={revealIssue}
                className="appearance-none border-none bg-transparent px-0 text-left font-body text-[11px] text-red-600 underline cursor-pointer"
              >
                Save is disabled: {issue}. Show me
              </button>
            )}
            <span className="ml-auto flex items-center gap-2">
              {confirmDiscard ? (
                <>
                  <button
                    onClick={discard}
                    // A discard that lands while the save it is racing is still
                    // in flight would revert the editor and then have the
                    // response overwrite it back.
                    disabled={busy !== null}
                    className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                  >
                    Confirm discard
                  </button>
                  <button
                    onClick={() => setConfirmDiscard(false)}
                    className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDiscard(true)}
                  disabled={busy !== null}
                  className="appearance-none rounded-[3px] border border-neutral-300 bg-white px-3 py-[6px] font-body text-[12px] text-neutral-700 cursor-pointer hover:bg-app-bg disabled:opacity-40 disabled:cursor-default"
                >
                  Discard
                </button>
              )}
              <button
                onClick={save}
                disabled={!valid || busy !== null}
                className="appearance-none border-none rounded-[3px] px-4 py-2 font-body text-[13px] font-semibold cursor-pointer bg-mariner text-white disabled:opacity-40 disabled:cursor-default"
              >
                {busy === "save" ? "Saving…" : "Save changes"}
              </button>
            </span>
          </div>
          <p className="mt-[6px] font-body text-[10px] text-neutral-500">{SAVE_SCOPE_NOTE}</p>
        </div>
      )}
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

/** A pasted block of shell lines, split the way a terminal history or a README
 *  snippet arrives. Blank lines are dropped: a copied block almost always ends
 *  in a newline, and a trailing empty row would be a fresh Save blocker handed
 *  to someone who just pasted their commands in correctly. */
function splitPastedCommands(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(nonBlank);
}

/** Row identity, minted per row and never derived from position or from the
 *  command text: two rows are allowed to hold the same command, and a move
 *  changes every position after it. Module-level counter, so ids stay unique
 *  across every list on the screen. */
let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `cmd-${rowIdCounter}`;
}

/** One editable list of shell commands: index, input, reorder, remove, add-row.
 *  Used for setup commands, legacy flat commands, and each group's commands. */
function CommandListEditor({
  commands,
  disabled,
  placeholder,
  addLabel,
  warnInstall,
  emptyNote,
  firstAddLabel,
  suppressBlankError,
  onChange,
}: {
  commands: string[];
  disabled: boolean;
  placeholder: string;
  addLabel: string;
  warnInstall?: boolean;
  /** Shown instead of a bare add-link when the list is empty. */
  emptyNote?: string;
  /** The add-link's wording while the list is empty. */
  firstAddLabel?: string;
  /** Keeps the blank-row error off a repository nobody has typed into yet (see
   *  isUntouchedNewEntry). Save is still blocked and still says why. */
  suppressBlankError?: boolean;
  onChange: (next: string[]) => void;
}) {
  // Keyed by identity rather than by index, so a moved row keeps its DOM node
  // and therefore its focus. With index keys React reused the node in place and
  // the button the person was pressing became a different row's button between
  // one Enter and the next, which made a two-step move impossible by keyboard.
  const [ids, setIds] = useState<string[]>(() => commands.map(() => nextRowId()));
  // The parent can also replace the list wholesale (Discard, Preview, a save
  // that comes back reordered) without passing through any handler here.
  const rowIds =
    ids.length === commands.length ? ids : commands.map((_, i) => ids[i] ?? `row-${i}`);
  useEffect(() => {
    setIds((prev) =>
      prev.length === commands.length ? prev : commands.map((_, i) => prev[i] ?? nextRowId()),
    );
  }, [commands.length]);

  // Focus follows the row, not the position: after a move the same button has
  // to be under the same finger, which is what lets Enter be pressed twice to
  // move a command two steps.
  const moveButtons = useRef(new Map<string, { focus: () => void } | null>());
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    moveButtons.current.get(target)?.focus();
  });
  // A move is invisible to a screen reader otherwise: the list simply reads
  // differently the next time it is walked, with nothing to say it changed.
  const [announcement, setAnnouncement] = useState("");

  function apply(nextCommands: string[], nextIds: string[]) {
    setIds(nextIds);
    onChange(nextCommands);
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= commands.length) return;
    const nextCommands = [...commands];
    const [movedCommand] = nextCommands.splice(from, 1);
    nextCommands.splice(to, 0, movedCommand);
    const nextIds = [...rowIds];
    const [movedId] = nextIds.splice(from, 1);
    nextIds.splice(to, 0, movedId);
    pendingFocus.current = `${movedId}:${to > from ? "down" : "up"}`;
    setAnnouncement(
      `${nonBlank(movedCommand) ? movedCommand : "Blank command"} moved to position ${to + 1} of ${
        commands.length
      }.`,
    );
    apply(nextCommands, nextIds);
  }

  /** A multi-line paste becomes one row per line at this position. The browser
   *  default is to concatenate them into a single input, which produces one
   *  command that runs everything joined by nothing at all. */
  function paste(index: number, event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!text.includes("\n")) return;
    event.preventDefault();
    const field = event.target as HTMLInputElement;
    const value = field.value ?? commands[index] ?? "";
    const start = field.selectionStart ?? value.length;
    const end = field.selectionEnd ?? start;
    const lines = splitPastedCommands(value.slice(0, start) + text + value.slice(end));
    apply(
      [...commands.slice(0, index), ...lines, ...commands.slice(index + 1)],
      [...rowIds.slice(0, index), ...lines.map(() => nextRowId()), ...rowIds.slice(index + 1)],
    );
  }

  return (
    <>
      {commands.length === 0 && emptyNote && (
        <div className="mb-[6px] font-body text-[11px] text-neutral-500">{emptyNote}</div>
      )}
      {commands.map((command, i) => (
        <div key={rowIds[i]} className="group mb-[6px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-neutral-400 w-4 text-right">{i + 1}.</span>
            <input
              value={command}
              disabled={disabled}
              onChange={(e) => onChange(commands.map((c, idx) => (idx === i ? e.target.value : c)))}
              onPaste={(e) => paste(i, e)}
              placeholder={placeholder}
              className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px] text-neutral-900 disabled:bg-app-bg"
            />
            {!disabled && commands.length > 1 && (
              // Order inside a group is the order the commands run in, so it
              // has to be editable without retyping every row. Revealed on
              // hover and on focus, so a keyboard reaches them too.
              <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <button
                  ref={(node) => {
                    moveButtons.current.set(`${rowIds[i]}:up`, node);
                  }}
                  onClick={() => move(i, i - 1)}
                  disabled={i === 0}
                  aria-label={`Move command ${i + 1} up`}
                  className="appearance-none border-none bg-transparent font-mono text-[11px] text-neutral-400 hover:text-mariner cursor-pointer disabled:opacity-30 disabled:cursor-default"
                >
                  ↑
                </button>
                <button
                  ref={(node) => {
                    moveButtons.current.set(`${rowIds[i]}:down`, node);
                  }}
                  onClick={() => move(i, i + 1)}
                  disabled={i === commands.length - 1}
                  aria-label={`Move command ${i + 1} down`}
                  className="appearance-none border-none bg-transparent font-mono text-[11px] text-neutral-400 hover:text-mariner cursor-pointer disabled:opacity-30 disabled:cursor-default"
                >
                  ↓
                </button>
              </span>
            )}
            {!disabled && (
              <button
                onClick={() =>
                  apply(
                    commands.filter((_, idx) => idx !== i),
                    rowIds.filter((_, idx) => idx !== i),
                  )
                }
                aria-label="Remove command"
                className="appearance-none border-none bg-transparent font-mono text-[13px] text-neutral-400 hover:text-red-600 cursor-pointer"
              >
                ×
              </button>
            )}
          </div>
          {command.trim() === "" && !suppressBlankError && (
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
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {!disabled && (
        <button
          onClick={() => apply([...commands, ""], [...rowIds, nextRowId()])}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer px-0"
        >
          + {commands.length === 0 && firstAddLabel ? firstAddLabel : addLabel}
        </button>
      )}
    </>
  );
}

function EnvNamesEditor({
  names,
  policy,
  disabled,
  onChange,
}: {
  names: string[];
  /** What this deployment forwards (`undefined` from a worker deployed before
   *  the field existed, which is no answer rather than an empty allowlist) and
   *  what this repository is already saved with. */
  policy: EnvPolicy;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const allowedEnv = policy.allowed;
  return (
    <>
      {allowedEnv !== undefined &&
        (allowedEnv.length === 0 ? (
          <div className="mb-[6px] font-body text-[11px] text-neutral-600">
            This deployment forwards no environment variables. Add them to {ALLOWED_ENV_VAR} and
            redeploy the worker.
          </div>
        ) : (
          <div className="mb-[6px] font-body text-[11px] text-neutral-600">
            Forwarded by this deployment:{" "}
            {allowedEnv.map((name) => (
              <button
                key={name}
                onClick={() => onChange([...names, name])}
                disabled={disabled || names.includes(name)}
                aria-label={`Add env var name ${name}`}
                className="mr-1 appearance-none rounded-[3px] border border-neutral-300 bg-white px-[6px] py-[2px] font-mono text-[11px] text-neutral-700 cursor-pointer hover:bg-app-bg disabled:opacity-40 disabled:cursor-default"
              >
                {name}
              </button>
            ))}
          </div>
        ))}
      {names.map((name, i) => {
        const invalid = !isValidEnvName(name);
        // Two different problems wearing the same symptom: a name that is not
        // stored yet cannot be saved at all, and a name that is stored is
        // failing runs right now. See EnvPolicy.
        const rejected = offAllowlist(name, policy) && !policy.saved.includes(name);
        const notForwarded = offAllowlist(name, policy) && policy.saved.includes(name);
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
            {rejected && (
              <div className="ml-0 mt-[3px] font-body text-[11px] text-red-600">
                {NOT_ALLOWLISTED_NOTE}
              </div>
            )}
            {notForwarded && <WarningLine text={NOT_FORWARDED_NOTE} />}
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
  radioGroupId,
  groupNames,
  gateGroups,
  disabled,
  onChange,
}: {
  /** Only to keep the two radios of one repository in their own native group,
   *  so arrow keys do not walk into a sibling repository's pair. It has to be
   *  repoKey(repo), never the path alone: the same path is allowed once per
   *  provider (github:acme/web and gitlab:acme/web are two cards), and a name
   *  shared between them would make all four inputs one native radio group. */
  radioGroupId: string;
  groupNames: string[];
  gateGroups: string[] | undefined;
  disabled: boolean;
  onChange: (next: string[] | undefined) => void;
}) {
  const allSelected = gateGroups === undefined;
  const radioName = `gate-mode-${radioGroupId}`;
  return (
    <div>
      <label className="flex items-center gap-2 mb-1 font-body text-[12px] text-neutral-800">
        <input
          type="radio"
          name={radioName}
          aria-label="Every group (default)"
          checked={allSelected}
          disabled={disabled}
          onChange={() => onChange(undefined)}
          className="w-3.5 h-3.5 accent-mariner"
        />
        Every group (default)
      </label>
      {allSelected && (
        <p className="ml-5 mb-1 font-body text-[10px] text-neutral-500">{GATING_ALL_GROUPS_NOTE}</p>
      )}
      <label className="flex items-center gap-2 mb-1 font-body text-[12px] text-neutral-800">
        <input
          type="radio"
          name={radioName}
          aria-label="Only the groups I select"
          checked={!allSelected}
          disabled={disabled}
          // Switching on selects everything, which keeps the gate running
          // exactly what it ran a moment ago: the user then unticks their way
          // down instead of watching groups drop out of the gate on a click.
          onChange={() => onChange(groupNames)}
          className="w-3.5 h-3.5 accent-mariner"
        />
        Only the groups I select
      </label>
      {!allSelected && (
        <>
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
                      // Unticking the last box leaves an empty explicit
                      // selection, which stays explicit: the list stays on
                      // screen and Save blocks on it. Falling back to "every
                      // group" here flipped the mode and hid the list, so a
                      // user clearing the boxes to start over ended up gating
                      // on everything without being told.
                      onChange(
                        e.target.checked
                          ? [...gateGroups, name]
                          : gateGroups.filter((g) => g !== name),
                      );
                    }}
                    className="w-3.5 h-3.5 accent-mariner"
                  />
                  {name}
                </label>
              );
            })}
          </div>
          <p className="ml-5 mt-1 font-body text-[10px] text-neutral-500">
            Groups you do not select will not run at the gate at all. They run only when a
            workflow block names them.
          </p>
        </>
      )}
    </div>
  );
}

/** One sentence: always on screen while the box is off, and one click on the
 *  (?) button away while it is on, so turning it back on does not cost the
 *  explanation. */
const RESTORE_TREE_NOTE =
  "On, the tracked files this group's commands modified are restored afterward. Turn off only for a group whose job is to edit the tree, such as an auto-formatter.";

function GroupCard({
  name,
  group,
  allGroups,
  otherGroupNames,
  cyclePath,
  atGate,
  open,
  onToggle,
  previewOpen,
  onTogglePreview,
  canDelete,
  willUngateOnDelete,
  pristine,
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
  /** Every sibling, because what this group runs is its whole extends closure
   *  and not only its own command list. */
  allGroups: Record<string, PrePrCheckGroupConfig>;
  otherGroupNames: string[];
  /** The extends cycle this group sits on, already narrowed to this card by
   *  GroupsSection, or null when it is not on one. */
  cyclePath: string[] | null;
  /** Whether the publication gate runs this group, i.e. the repository gates
   *  on every group or its selection names this one. */
  atGate: boolean;
  /** Owned by the screen (see EditorUi) and keyed by name, so a save that
   *  reorders the groups leaves the open card on the same group. */
  open: boolean;
  onToggle: () => void;
  /** The run-order preview, held in the same screen-level key set as the card
   *  itself so it survives a collapse and follows a rename. */
  previewOpen: boolean;
  onTogglePreview: () => void;
  canDelete: boolean;
  /** True when this is the only group the gate selection currently names, so
   *  deleting it collapses the gate back to "every group". */
  willUngateOnDelete: boolean;
  /** The repository was added a moment ago and nothing has been typed into it
   *  yet (see isUntouchedNewEntry), so its emptiness is a starting point rather
   *  than an error. */
  pristine: boolean;
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
  // The rename warning is about an edit in progress, so it shows while one is,
  // rather than in all nine cards at all times.
  const [nameFocused, setNameFocused] = useState(false);
  // Explains the "not applied yet" state at the field, not only above Save.
  const restoreNoteId = useId();
  const [restoreNoteOpen, setRestoreNoteOpen] = useState(false);
  // Removing a group is not undoable from this screen (only through History),
  // and it silently retires every workflow block that names it, so it takes two
  // clicks and says so between them.
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Every keystroke stays visible here and nowhere else: the rename reaches
  // the config on blur or Enter only. Committing per keystroke really did
  // rename the group to each prefix along the way ("t", "te", "tes"), so a
  // final name that collided left the group named after a prefix, with
  // gateGroups and every extends reference rewritten to match. Cards are keyed
  // by the committed name, so `name` never changes under a mounted card and
  // the draft only has to be seeded once.
  const [draftName, setDraftName] = useState(name);
  const pendingReason: PendingGroupNameDraft["reason"] | null =
    draftName === name
      ? null
      : otherGroupNames.includes(draftName)
        ? "duplicate"
        : !isValidGroupName(draftName)
          ? "invalid"
          : "uncommitted";

  // Stable for this card's whole lifetime, so the draft report always targets
  // the same slot even when a sibling is deleted.
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

  /** Blur and Enter, never a keystroke. A draft that cannot be taken (it
   *  duplicates a sibling or is not a legal name) stays a draft and keeps
   *  blocking Save, so nothing is lost silently. */
  function commitRename() {
    if (draftName === name) return;
    if (otherGroupNames.includes(draftName) || !isValidGroupName(draftName)) return;
    onRename(draftName);
  }

  /** Escape, closing the card, and unmounting all land here: the committed
   *  name is whatever it was when the field took focus. */
  function revertRename() {
    setDraftName(name);
  }

  const rowProblem = groupRowProblem(name, group, cyclePath);
  const restoreTree = group.restoreTree !== false;

  if (!open) {
    return (
      <div className="rounded-[3px] border border-neutral-200 bg-white px-3 py-2 mb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            aria-expanded={false}
            className="flex flex-1 items-center gap-2 appearance-none border-none bg-transparent px-0 text-left font-mono text-[12px] text-neutral-700 cursor-pointer"
          >
            <Caret open={false} />
            <span className="font-semibold text-neutral-900">{name}</span>
            <span className="font-body text-[11px] text-neutral-500">
              {" · "}
              {groupSummaryTail(group)}
            </span>
          </button>
          <GateChip atGate={atGate} />
        </div>
        {rowProblem && <ProblemLine text={rowProblem} />}
      </div>
    );
  }

  return (
    <div className="rounded-[3px] border border-neutral-200 bg-white px-3 py-2 mb-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <button
          onClick={() => {
            // A draft the config never took would otherwise keep blocking Save
            // from behind a closed card, with no field left to correct it in.
            // Closing reverts it, exactly as unmounting the card does.
            revertRename();
            onToggle();
          }}
          aria-expanded
          aria-label={`Collapse group ${name}`}
          className="appearance-none border-none bg-transparent px-0 cursor-pointer"
        >
          <Caret open />
        </button>
        <input
          value={draftName}
          disabled={disabled}
          onFocus={() => setNameFocused(true)}
          onBlur={() => {
            setNameFocused(false);
            commitRename();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") revertRename();
          }}
          onChange={(e) => setDraftName(e.target.value)}
          className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[4px] font-mono text-[12px] font-semibold text-neutral-900 disabled:bg-app-bg"
        />
        <GateChip atGate={atGate} />
        {!disabled && canDelete && !confirmDelete && (
          <button
            onClick={() => setConfirmDelete(true)}
            className="appearance-none border-none bg-transparent font-body text-[11px] text-neutral-500 hover:text-red-600 cursor-pointer"
          >
            Remove group
          </button>
        )}
        {!disabled && canDelete && confirmDelete && (
          <>
            <button
              onClick={onDelete}
              className="appearance-none border-none bg-transparent font-body text-[11px] font-semibold text-red-600 cursor-pointer"
            >
              Confirm remove group
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="appearance-none border-none bg-transparent font-body text-[11px] text-neutral-500 cursor-pointer"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {confirmDelete && canDelete && (
        <div className="mb-2 font-body text-[11px] text-burnt-orange">{GROUP_REMOVAL_NOTE}</div>
      )}
      {(nameFocused || draftName !== name) && (
        <p className="mb-2 font-body text-[10px] text-neutral-500">
          Workflow blocks that name this group will not follow a rename or removal and will report
          not_run.
        </p>
      )}
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
      {pendingReason === "uncommitted" && (
        <div className="mb-2 font-body text-[11px] text-burnt-orange">
          Not applied yet. Press Enter or click outside the field to rename the group, or Escape
          to keep &quot;{name}&quot;.
        </div>
      )}
      {canDelete && willUngateOnDelete && (
        <div className="mb-2 font-body text-[11px] text-burnt-orange">
          This is the only group the gate selection names. Removing it will leave nothing
          selected.{" "}
          {GATING_ALL_GROUPS_NOTE}
        </div>
      )}

      <div className="font-body text-[11px] font-semibold text-neutral-700 mb-1">Commands</div>
      <CommandListEditor
        commands={group.commands ?? []}
        disabled={disabled}
        placeholder="pnpm test"
        addLabel="Add command"
        emptyNote="No commands yet."
        firstAddLabel="Add the first command"
        suppressBlankError={pristine}
        warnInstall
        onChange={onCommandsChange}
      />
      {pristine ? (
        <div className="mb-2 font-body text-[11px] text-neutral-500">
          Add at least one command to save.
        </div>
      ) : (
        noCommandsOrExtends && (
          <div className="mb-2 font-body text-[11px] text-red-600">
            This group has no commands and does not extend another group, so it will not run. Add a
            command or extend a group below.
          </div>
        )
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

      <div className="mt-2 flex items-center gap-2">
        <label
          className="flex items-center gap-2 font-body text-[11px] text-neutral-700"
          title={RESTORE_TREE_NOTE}
        >
          <input
            type="checkbox"
            checked={restoreTree}
            disabled={disabled}
            onChange={(e) => onToggleRestoreTree(e.target.checked)}
            className="w-3.5 h-3.5 accent-mariner"
          />
          Restore tree after running
        </label>
        {restoreTree && (
          // A real button, not a title-only glyph: a tooltip is unreachable by
          // keyboard, by touch, and to a screen reader, and this sentence is
          // the only place the default behaviour is explained. It sits outside
          // the label so clicking it does not toggle the checkbox.
          <button
            onClick={() => setRestoreNoteOpen(!restoreNoteOpen)}
            aria-expanded={restoreNoteOpen}
            aria-controls={restoreNoteId}
            aria-label="What restoring the tree does"
            className="appearance-none border-none bg-transparent px-0 font-mono text-[10px] text-neutral-400 hover:text-mariner cursor-pointer"
          >
            (?)
          </button>
        )}
      </div>
      {(!restoreTree || restoreNoteOpen) && (
        <p id={restoreNoteId} className="font-body text-[10px] text-neutral-500 mt-[2px]">
          {RESTORE_TREE_NOTE}
        </p>
      )}

      {/* Last, because it answers what the whole card adds up to: the commands
          above plus everything the extends selection pulls in, in order. */}
      <PreviewDisclosure label="Preview run order" open={previewOpen} onToggle={onTogglePreview}>
        <RunOrderPreview groups={allGroups} groupNames={[name]} />
      </PreviewDisclosure>
    </div>
  );
}

function GroupsSection({
  repo,
  disabled,
  pristine,
  ui,
  onChange,
  onGroupDraft,
}: {
  repo: PrePrCheckRepositoryConfig;
  disabled: boolean;
  pristine: boolean;
  ui: EditorUi;
  onChange: (next: PrePrCheckRepositoryConfig) => void;
  onGroupDraft: (id: string, draft: PendingGroupNameDraft | null) => void;
}) {
  const groups = repo.groups ?? {};
  // Key order as it arrives, not a sort. The server hands back a canonical
  // order from withCanonicalGroupOrder, but that is the only thing that
  // guarantees it: jsonb itself orders keys by length and then bytes, and a
  // restored version can carry an order nothing normalized. So the order here
  // is whatever the payload holds, which is exactly why nothing that has to
  // survive it (open cards, gate notes) may be keyed by position.
  const names = Object.keys(groups);
  // Once per repository, so every card on the cycle can name it where the
  // user is rather than only in the blocker above Save.
  const cyclePath = findExtendsCycle(groups);
  const rk = repoKey(repo);
  const groupKey = (name: string) => uiKey(rk, name);
  // A second key per group, in the same set: the card's own open flag must not
  // carry the preview open with it, and the preview must still survive the card
  // closing. The suffix cannot collide with a group name (no group name may
  // contain a NUL, see uiKey).
  const previewKey = (name: string) => `${groupKey(name)}${UI_KEY_SEP}preview`;
  // Groups the last add put into the gate selection, held at the screen so
  // closing the repository does not lose the note while the gate keeps them.
  const autoGated = ui.autoGatedNames(rk).filter((name) => names.includes(name));

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
    // A group added a second ago is usually renamed right after, so its open
    // card, its preview and its undo link all follow the new name.
    ui.renameKey(groupKey(oldName), groupKey(newName));
    ui.renameKey(previewKey(oldName), previewKey(newName));
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
    // With an explicit selection, a group left out of it does not run at the
    // gate at all, so a new group would silently never join it. Joining it and
    // saying so beats a group that quietly checks nothing.
    const explicitGate = repo.gateGroups !== undefined;
    onChange({
      ...repo,
      groups: { ...groups, [name]: { commands: [""] } },
      ...(explicitGate ? { gateGroups: [...repo.gateGroups!, name] } : {}),
    });
    ui.reveal(groupKey(name));
    if (explicitGate) ui.markAutoGated(groupKey(name));
  }

  function undoGateAdd(name: string) {
    // Straight to the selection without the "empty means every group" fallback:
    // an empty explicit selection stays explicit and blocks Save, rather than
    // flipping the gate to every group behind the user's back.
    onChange({ ...repo, gateGroups: (repo.gateGroups ?? []).filter((g) => g !== name) });
    ui.clearAutoGated(groupKey(name));
  }

  function updateGroup(name: string, next: PrePrCheckGroupConfig) {
    onChange({ ...repo, groups: { ...groups, [name]: next } });
  }

  return (
    <div>
      <p className="font-body text-[11px] text-neutral-500 mb-2">
        Script groups are listed by name. Run order follows extends, not the position in this list.
      </p>
      {names.map((name) => (
        <GroupCard
          // Keyed by the committed name, which no longer moves while a rename
          // is being typed (it commits on blur or Enter), and which a save
          // reordering the keys cannot re-target the way an index does.
          key={name}
          name={name}
          group={groups[name]}
          allGroups={groups}
          otherGroupNames={names.filter((n) => n !== name)}
          cyclePath={cyclePath?.includes(name) ? cyclePath : null}
          atGate={runsAtGate(repo, name)}
          open={ui.isOpen(groupKey(name))}
          onToggle={() => ui.toggle(groupKey(name))}
          previewOpen={ui.isOpen(previewKey(name))}
          onTogglePreview={() => ui.toggle(previewKey(name))}
          pristine={pristine}
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
      {autoGated.length > 0 && (
        <div className="mb-3 font-body text-[11px] text-neutral-600">
          Added to the gate selection:{" "}
          {autoGated.map((name, i) => (
            <React.Fragment key={name}>
              {i > 0 && ", "}
              <span className="font-mono">{name}</span>{" "}
              <button
                onClick={() => undoGateAdd(name)}
                className="appearance-none border-none bg-transparent px-0 font-body text-[11px] text-mariner cursor-pointer"
              >
                undo
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      <div className="mt-1">
        <div className="font-body text-[12px] font-semibold text-neutral-800 mb-1">
          What runs at the publication gate
        </div>
        <GateGroupsEditor
          radioGroupId={repoKey(repo)}
          groupNames={names}
          gateGroups={repo.gateGroups}
          disabled={disabled}
          onChange={(next) => {
            // A name the user unticks, or drops by switching back to every
            // group, is no longer something the add just did for them.
            for (const name of repo.gateGroups ?? []) {
              if (next === undefined || !next.includes(name)) ui.clearAutoGated(groupKey(name));
            }
            onChange({ ...repo, gateGroups: next });
          }}
        />
      </div>
    </div>
  );
}

function RepoCard({
  repo,
  open,
  disabled,
  ui,
  envPolicy,
  inCatalog,
  pristine,
  onToggle,
  onChange,
  onRemove,
  onGroupDraft,
}: {
  repo: PrePrCheckRepositoryConfig;
  open: boolean;
  disabled: boolean;
  ui: EditorUi;
  /** What this deployment forwards and what this repository is already saved
   *  with, which is what separates a rejected save from a broken run. */
  envPolicy: EnvPolicy;
  /** Whether the repository catalog lists this path: `null` while nobody has
   *  asked it, or when the provider could not be listed at all. */
  inCatalog: boolean | null;
  /** Added a moment ago and not typed into yet (see isUntouchedNewEntry). */
  pristine: boolean;
  onToggle: () => void;
  onChange: (next: PrePrCheckRepositoryConfig) => void;
  onRemove: () => void;
  onGroupDraft: (id: string, draft: PendingGroupNameDraft | null) => void;
}) {
  const isGrouped = Object.keys(repo.groups ?? {}).length > 0;
  const setupCount = (repo.setup ?? []).length;
  const envCount = (repo.env ?? []).length;
  const sectionKey = (id: string) => sectionKeyOf(repoKey(repo), id);
  // Collapsing must never hide a reason Save is disabled, so the summary row
  // carries the repository's first problem verbatim.
  const rowProblem = firstRepoIssue(repo, envPolicy);
  // Removing a repository takes its groups, setup and env with it and cannot be
  // undone from this screen, so it takes two clicks like a restore does.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const plan = gatePlan(repo);

  return (
    <div
      id={repoDomId(repoKey(repo))}
      className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3 mb-3"
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 appearance-none border-none bg-transparent px-0 text-left cursor-pointer"
        >
          <Caret open={open} />
          <span className="font-mono text-[13px] text-neutral-900">{repo.repoPath}</span>
          <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-600">
            {repo.provider}
          </span>
          {!isGrouped && (
            <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
              runs as group &quot;{LEGACY_GROUP_NAME}&quot;
            </span>
          )}
          {!open && (
            <span className="font-body text-[11px] text-neutral-500">
              {" · "}
              {repoSummary(repo)}
            </span>
          )}
        </button>
        {!disabled && !confirmRemove && (
          <button
            onClick={() => setConfirmRemove(true)}
            className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 hover:text-red-600 cursor-pointer"
          >
            Remove
          </button>
        )}
        {!disabled && confirmRemove && (
          <>
            <button
              onClick={onRemove}
              className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer"
            >
              Confirm remove
            </button>
            <button
              onClick={() => setConfirmRemove(false)}
              className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {confirmRemove && (
        <div className="mt-[3px] font-body text-[11px] text-burnt-orange">
          {REPOSITORY_REMOVAL_NOTE}
        </div>
      )}
      {!open && rowProblem && <ProblemLine text={rowProblem} />}
      {inCatalog === false && (
        <WarningLine
          text={`Not found in the ${repo.provider} catalog. Scripts for this path will never run.`}
        />
      )}

      {open && (
        <div className="mt-2">
          <div className="font-body text-[12px] font-semibold text-neutral-800 mb-[6px]">
            {isGrouped ? "Script groups" : "Commands (legacy)"}
          </div>
          {isGrouped ? (
            <GroupsSection
              repo={repo}
              disabled={disabled}
              pristine={pristine}
              ui={ui}
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
                emptyNote="No commands yet."
                warnInstall
                onChange={(commands) => onChange({ ...repo, commands })}
              />
              {!disabled && (
                <button
                  onClick={() =>
                    onChange({
                      ...repo,
                      groups: { [LEGACY_GROUP_NAME]: { commands: repo.commands ?? [] } },
                      commands: undefined,
                    })
                  }
                  className="mt-2 appearance-none rounded-[3px] border border-neutral-300 bg-white px-2 py-1 font-body text-[11px] text-neutral-700 cursor-pointer hover:bg-app-bg"
                >
                  Convert to groups
                </button>
              )}
              <p className="mt-1 font-body text-[10px] text-neutral-500">
                Older format, still fully supported. Convert to add env vars, extends and per-group
                gating. Conversion cannot be undone here, only through History.
              </p>
            </>
          )}

          <PreviewDisclosure
            label="Preview gate plan"
            open={ui.isOpen(sectionKey("gate-preview"))}
            onToggle={() => ui.toggle(sectionKey("gate-preview"))}
          >
            <RunOrderPreview groups={plan.groups} groupNames={plan.names} />
          </PreviewDisclosure>

          <SecondaryRow
            label={`Setup (${setupCount === 0 ? "none" : countLabel(setupCount, "command")})`}
            problem={firstSetupIssue(repo)}
            open={ui.isOpen(sectionKey("setup"))}
            onToggle={() => ui.toggle(sectionKey("setup"))}
          >
            <p className="font-body text-[11px] text-neutral-500 mb-[6px]">
              Runs once before any script group, for installing a toolchain the sandbox does not
              ship. A failed setup command blocks the run.
            </p>
            <CommandListEditor
              commands={repo.setup ?? []}
              disabled={disabled}
              placeholder="make bootstrap"
              addLabel="Add setup command"
              onChange={(setup) => onChange({ ...repo, setup })}
            />
          </SecondaryRow>

          {isGrouped && (
            <SecondaryRow
              label={`Env vars (${envCount === 0 ? "none" : envCount})`}
              problem={firstEnvIssue(repo, envPolicy)}
              warning={firstEnvWarning(repo, envPolicy)}
              open={ui.isOpen(sectionKey("env"))}
              onToggle={() => ui.toggle(sectionKey("env"))}
            >
              <p className="font-body text-[11px] text-neutral-500 mb-[6px]">
                NAMES only, never values. The worker looks up each one in its own environment and
                refuses any name it has not allowlisted for forwarding.
              </p>
              <EnvNamesEditor
                names={repo.env ?? []}
                policy={envPolicy}
                disabled={disabled}
                onChange={(env) => onChange({ ...repo, env })}
              />
            </SecondaryRow>
          )}

          <SecondaryRow
            label={`Per-command timeout (${
              repo.commandTimeoutMinutes === undefined
                ? "default"
                : `${repo.commandTimeoutMinutes} min`
            })`}
            problem={firstTimeoutIssue(repo)}
            open={ui.isOpen(sectionKey("timeout"))}
            onToggle={() => ui.toggle(sectionKey("timeout"))}
          >
            <p className="font-body text-[11px] text-neutral-500 mb-[6px]">
              Minutes, per command. Leave blank for the default, which is{" "}
              {DEFAULT_COMMAND_TIMEOUT_MINUTES} minutes unless this deployment sets
              PRE_PR_COMMAND_TIMEOUT_MINUTES.
            </p>
            <TimeoutMinutesField
              value={repo.commandTimeoutMinutes}
              disabled={disabled}
              placeholder={String(DEFAULT_COMMAND_TIMEOUT_MINUTES)}
              onChange={(v) => onChange({ ...repo, commandTimeoutMinutes: v })}
            />
          </SecondaryRow>
        </div>
      )}
    </div>
  );
}

function providerStatusLabel(status: RepositoryProviderStatus): string {
  if (status.status === "not_connected") return "not connected";
  if (status.status === "error") return status.error ?? "could not list repositories";
  return "ready";
}

/** One path segment: a repository or namespace name as both providers spell
 *  them. Deliberately narrow, because a path that is not one of these can never
 *  match a repository the runner sees. */
const REPO_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** GitHub is always owner/repo. GitLab allows subgroups, so two segments or
 *  more. Exported for the tests, which is cheaper than proving the shape
 *  through the picker. */
export function isValidRepoPath(provider: "github" | "gitlab", path: string): boolean {
  const segments = path.split("/");
  if (!segments.every((segment) => REPO_PATH_SEGMENT.test(segment))) return false;
  return provider === "github" ? segments.length === 2 : segments.length >= 2;
}

/** A pasted browser URL reduced to the path the config stores. Anything that is
 *  not an http(s) URL is returned untouched, so typing is never fought: the
 *  rewrite only fires once a value actually carries a scheme and a host. */
export function stripRepoUrl(value: string): string {
  const match = /^https?:\/\/[^/]+\/(.+)$/.exec(value.trim());
  if (match === null) return value;
  const path = match[1]
    .split(/[?#]/)[0]
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "")
    // GitLab hangs everything that is not the project path off `/-/`.
    .split("/-/")[0];
  const segments = path.split("/");
  // GitHub deep links (/tree/main/..., /blob/..., /pull/12) sit directly after
  // owner/repo, so anything from there on is not part of the path.
  const cut = segments.findIndex(
    (segment, i) => i > 1 && ["tree", "blob", "pull", "issues", "commits"].includes(segment),
  );
  return (cut === -1 ? segments : segments.slice(0, cut)).join("/");
}

function AddRepository({
  configured,
  catalog,
  catalogFailed,
  onOpen,
  onAdd,
}: {
  configured: PrePrCheckRepositoryConfig[];
  /** Fetched and held by the screen, which also badges a configured repository
   *  the catalog does not list, so the picker renders whatever already landed
   *  instead of asking for it again. */
  catalog: RepositoriesResponse | null;
  catalogFailed: boolean;
  /** Asks the screen to load the catalog if it has not already. */
  onOpen: () => void;
  onAdd: (repo: { provider: "github" | "gitlab"; repoPath: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [manualProvider, setManualProvider] = useState<"github" | "gitlab">("github");
  const [manualPath, setManualPath] = useState("");

  const options: RepositoryOption[] | null = catalog?.repositories ?? null;
  const providers: RepositoryProviderStatus[] = catalog?.providers ?? [];
  const failed = catalogFailed;

  const isConfigured = (provider: string, repoPath: string) =>
    configured.some((r) => r.provider === provider && r.repoPath === repoPath);

  function openPicker() {
    setOpen(true);
    onOpen();
  }

  const manualTrimmed = manualPath.trim();
  const manualIssue =
    manualTrimmed === ""
      ? null
      : !isValidRepoPath(manualProvider, manualTrimmed)
        ? manualProvider === "github"
          ? "Enter owner/repo, or paste the repository URL."
          : "Enter group/repo or group/subgroup/repo, or paste the repository URL."
        : isConfigured(manualProvider, manualTrimmed)
          ? "This repository is already configured."
          : null;

  function addManual() {
    if (manualTrimmed === "" || manualIssue !== null) return;
    onAdd({ provider: manualProvider, repoPath: manualTrimmed });
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
      <div className="mt-2 border-t border-neutral-200 pt-2">
        <div className="flex items-center gap-2">
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
            // A pasted browser URL is reduced to the path here rather than
            // stored as one: a repoPath of "https://github.com/acme/web" never
            // matches a repository, and nothing downstream would ever say so.
            onChange={(e) => setManualPath(stripRepoUrl(e.target.value))}
            placeholder="owner/repo"
            className="flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 py-[5px] font-mono text-[12px]"
          />
          <button
            onClick={addManual}
            disabled={manualTrimmed === "" || manualIssue !== null}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-2 py-[5px] font-body text-[12px] cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            Add
          </button>
        </div>
        {manualIssue && (
          <div className="mt-[3px] font-body text-[11px] text-red-600">{manualIssue}</div>
        )}
      </div>
    </div>
  );
}
