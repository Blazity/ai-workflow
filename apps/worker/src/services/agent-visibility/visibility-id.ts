/**
 * The identity transform capture applies to a node id and an activation scope
 * id before it stores them.
 *
 * WHY THE READER NEEDS IT. A caller filters by an id it read off the graph, and
 * the graph keeps the raw one; `agent_briefings` keeps the shortened one. A
 * filter compared without this transform silently matches nothing for a loop
 * around a long-named node, which reads as "this block never sent anything".
 * The replay's own attempt rows are written by the runtime and keep the RAW id,
 * so the two tables disagree exactly above the bound, and joining them means
 * bringing both sides through this function.
 *
 * TWO COPIES, ONE ALGORITHM, FOR NOW. The other is `shortenVisibilityId` in
 * `apps/worker/src/engine/agent-visibility/plan.ts` (stage 3b), which cannot be
 * imported here: a service reaching into the engine is backwards, and the
 * engine half has to stay inside workflow scope, where there is no Node module
 * and no async hashing. Once both halves are on one branch this belongs in
 * `@shared/agent-visibility`, which both sides already import, and one of these
 * two copies goes. `shortenVisibilityId.test.ts` pins the vectors so a drift
 * between them is a red test rather than an empty list.
 */

const VISIBILITY_ID_MAX = 200;
const VISIBILITY_ID_HEAD = 150;

/** FNV-1a, 32 bits, over the CODE POINTS of the string, so the same id hashes
 *  the same wherever it is recomputed. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (const character of text) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * `id` unchanged when it fits, else its first 150 characters, a `~`, and two
 * FNV-1a passes over the code points of the WHOLE id (offset basis then prime
 * as the seed) as 16 lower-case hex characters. At most 167 characters.
 *
 * Idempotent, which is what lets a caller hand back an id it was served: the
 * result is under the bound, so shortening it again returns it unchanged.
 */
export function shortenVisibilityId(id: string): string {
  if (id.length <= VISIBILITY_ID_MAX) return id;
  let head = VISIBILITY_ID_HEAD;
  // Never cut between the two halves of one character: a code point above the
  // basic plane starting one before the cut is exactly that case.
  const straddling = id.codePointAt(head - 1);
  if (straddling !== undefined && straddling > 0xffff) head -= 1;
  const digest = `${fnv1a32(id, 0x811c9dc5).toString(16).padStart(8, "0")}${fnv1a32(id, 0x01000193)
    .toString(16)
    .padStart(8, "0")}`;
  return `${id.slice(0, head)}~${digest}`;
}
