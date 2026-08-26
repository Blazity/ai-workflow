// Pure helpers over the repository scripts group graph, shared by the worker's
// config schema (server-side validation) and the dashboard editor (client-side
// Save blocking), so both sides agree on what a valid group graph is and in
// which order groups are listed.

interface GroupWithExtends {
  extends?: string[];
}

interface GroupWithCommands extends GroupWithExtends {
  commands: string[];
}

/** The minimum a repository entry has to expose for its group graph to be
 *  walked. Structural on purpose: the worker holds a schema-validated
 *  RepoScriptsRepositoryConfig and the dashboard holds an editor draft, and
 *  both satisfy this without either importing the other's type. */
interface RepositoryWithGroups {
  groups: Record<string, GroupWithCommands>;
}

/**
 * Canonical shape of a script group name, shared by the worker's zod schemas
 * and the dashboard's client-side validation so the two can never drift: a
 * name accepted on one side and refused on the other could never match
 * anything at run time.
 */
export const REPOSITORY_SCRIPT_GROUP_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
export const REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH = 40;
export const REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE =
  "group name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens";

/**
 * Depth-first search over the extends graph, looking for a back edge to a
 * group still on the current path (grey). Returns the cycle as a path that
 * starts and ends on the same group (for example `["lint", "verify", "lint"]`),
 * or `null` when the graph is a DAG. Unknown references are skipped: the
 * caller reports them separately, and walking into them would either throw or
 * produce a confusing second issue for the same typo.
 */
export function findExtendsCycle(groups: Record<string, GroupWithExtends>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];

  function visit(name: string): string[] | null {
    color.set(name, GRAY);
    path.push(name);
    for (const ref of groups[name]?.extends ?? []) {
      if (!Object.prototype.hasOwnProperty.call(groups, ref)) continue;
      const refColor = color.get(ref) ?? WHITE;
      if (refColor === GRAY) {
        const cycleStart = path.indexOf(ref);
        return [...path.slice(cycleStart), ref];
      }
      if (refColor === WHITE) {
        const found = visit(ref);
        if (found) return found;
      }
    }
    path.pop();
    color.set(name, BLACK);
    return null;
  }

  for (const name of sortedGroupNames(groups)) {
    if ((color.get(name) ?? WHITE) === WHITE) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return null;
}

/** One command an expansion produced, with the group that DECLARES it: the
 *  group whose own `commands` list carries the string, never the selected
 *  group whose expansion happened to reach it. Ownership has to be a property
 *  of the configuration, because a shared command runs once and its single
 *  result is read back as "what this group did". */
export interface RepoScriptsExpandedCommand {
  command: string;
  group: string;
}

/**
 * The name of the error a cyclic `extends` chain throws, so a caller can tell
 * an author's broken draft from a genuine bug without matching on message text.
 */
export const REPOSITORY_SCRIPT_GROUP_CYCLE_ERROR = "RepositoryScriptGroupCycleError";

/**
 * Depth-first expansion of a group's `extends` chain into a flat command
 * list: dependencies run before the group's own commands, and a command that
 * appears more than once (shared by two extended groups, or repeated by the
 * group itself) only runs at its first occurrence, keeping the declaring group
 * of that occurrence.
 *
 * A cycle throws a REPOSITORY_SCRIPT_GROUP_CYCLE_ERROR naming the back edge.
 * The worker only ever passes schema-validated repositories, whose graph is
 * already known to be a DAG, but the editor previews an unvalidated draft while
 * someone is still typing, and the alternative there is an unattributable
 * RangeError from a stack that overflowed.
 *
 * Two groups declaring the IDENTICAL command text is the deliberate case: it
 * runs once, and the run is attributed to the first declarer this walk reaches,
 * which for a whole-repository plan is the alphabetically first group. Both
 * groups still inherit its verdict, because a group is judged over its whole
 * expansion (workflows/blocks/pre-pr-checks.ts groupStatusesFor), so neither
 * can read as passed while their shared command failed.
 *
 * Shared rather than worker-owned so the editor can preview exactly what the
 * worker will run: a preview computed by a second implementation is a promise
 * about execution that nothing keeps.
 */
export function expandGroupCommands(
  repo: RepositoryWithGroups,
  groupNames: string[],
): RepoScriptsExpandedCommand[] {
  const seen = new Set<string>();
  const commands: RepoScriptsExpandedCommand[] = [];
  // The groups on the current path, grey in the usual three-colour sense. A
  // plain visited set would not do: a diamond (two groups extending one
  // dependency) revisits a black group legitimately, and only a back edge into
  // a group still on the path is a cycle.
  const visiting = new Set<string>();
  const path: string[] = [];

  function visitGroup(name: string): void {
    const group = repo.groups[name];
    if (!group) {
      throw new Error(`unknown group: "${name}"`);
    }
    if (visiting.has(name)) {
      const error = new Error(
        `cycle in extends: ${[...path.slice(path.indexOf(name)), name].join(" -> ")}`,
      );
      error.name = REPOSITORY_SCRIPT_GROUP_CYCLE_ERROR;
      throw error;
    }
    visiting.add(name);
    path.push(name);
    for (const dep of group.extends ?? []) {
      visitGroup(dep);
    }
    for (const command of group.commands) {
      if (!seen.has(command)) {
        seen.add(command);
        commands.push({ command, group: name });
      }
    }
    path.pop();
    visiting.delete(name);
  }

  for (const name of groupNames) {
    visitGroup(name);
  }

  return commands;
}

/**
 * Groups are a set keyed by name; the config is stored as jsonb, which does
 * not preserve object key order (Postgres reorders keys by length, then
 * alphabetically). Every place that lists groups (the editor cards, the
 * default "all groups" execution order, reports) goes through this helper so
 * the order is the same everywhere and does not change on a save/reload
 * round-trip: plain code-point order of the group names. Dependencies between
 * groups are expressed with `extends`, never with position.
 */
export function sortedGroupNames(groups: Record<string, unknown>): string[] {
  return Object.keys(groups).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Rebuilds every repository's `groups` object with its keys in
 * `sortedGroupNames` order, leaving everything else untouched. Applied once,
 * where the config is read back from storage, so every consumer that walks
 * `Object.keys(repo.groups)` (the editor's cards, the block panel's group
 * picker, JSON shown to a human) sees the same canonical order without
 * sorting again on its own. Entries without `groups` (legacy flat shape) pass
 * through as they are.
 */
export function withCanonicalGroupOrder<T extends { repositories: unknown[] }>(
  config: T,
): T {
  return {
    ...config,
    repositories: config.repositories.map((entry) => {
      // `unknown[]`, not an array of a shape with only optional fields: a
      // repository entry that declares none of them (a legacy flat command
      // list) is not assignable to such a shape at all, and the callers hold
      // the config under several types that all reach this one function.
      const repo = entry as { groups?: Record<string, unknown> };
      if (!repo.groups) return entry;
      const groups: Record<string, unknown> = {};
      for (const name of sortedGroupNames(repo.groups)) groups[name] = repo.groups[name];
      return { ...repo, groups };
    }),
  };
}
