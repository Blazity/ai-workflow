// Pure helpers over the repository scripts group graph, shared by the worker's
// config schema (server-side validation) and the dashboard editor (client-side
// Save blocking), so both sides agree on what a valid group graph is and in
// which order groups are listed.

interface GroupWithExtends {
  extends?: string[];
}

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
