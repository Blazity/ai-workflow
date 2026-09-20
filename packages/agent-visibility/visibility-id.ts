/**
 * The identity transform capture applies to a node id and an activation scope
 * id before it stores them, and every reader applies before it joins on one.
 *
 * WHY IT EXISTS. The scheduler builds a loop's activation scope as
 * `${ownerScopeId}/loop:${node.id}:${iteration}` and nests it per level, while
 * a node id is legal up to 200 characters, so one loop around a long-named
 * node already passes `AGENT_VISIBILITY_ID_MAX_LENGTH`. Refusing there would
 * lose every send inside that loop, which is the opposite of what this feature
 * is for, so an id too long is SHORTENED deterministically instead: a readable
 * head, a tilde, and a hash of the whole id.
 *
 * WHY IT IS HERE AND NOT IN EITHER HALF. The writer and the reader have to
 * agree on this function exactly, or an id the API serves is not an id the
 * capture wrote and a filter silently matches nothing, which reads to a person
 * as "this block never sent anything". Neither half may import the other (a
 * service reaching into the engine is backwards, and the engine half has to
 * stay inside workflow scope), so the only place both can reach is this
 * package, which both already depend on. It was two byte-identical copies
 * until 2026-09-20.
 *
 * WHAT IT MAY USE. Nothing but this package: it runs inside the workflow
 * isolate, which has no Node module and no async hashing, so the hash is a
 * synchronous, pure FNV-1a rather than a real digest. Collision resistance is
 * not the job; telling two long ids apart is.
 */
import { AGENT_VISIBILITY_ID_MAX_LENGTH } from "./limits";
import { splitsSurrogatePair } from "./text";

/**
 * How much of a too-long id stays readable. Deliberately well under the bound,
 * so the head plus the separator plus the digest always fits: change it only
 * together with `AGENT_VISIBILITY_ID_MAX_LENGTH`, and know that every briefing
 * already stored under a long id carries the old spelling.
 */
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
  if (id.length <= AGENT_VISIBILITY_ID_MAX_LENGTH) return id;
  // Never cut between the two halves of one character: a code point above the
  // basic plane starting one before the cut is exactly that case.
  const head = splitsSurrogatePair(id, VISIBILITY_ID_HEAD) ? VISIBILITY_ID_HEAD - 1 : VISIBILITY_ID_HEAD;
  const digest = `${fnv1a32(id, 0x811c9dc5).toString(16).padStart(8, "0")}${fnv1a32(id, 0x01000193)
    .toString(16)
    .padStart(8, "0")}`;
  return `${id.slice(0, head)}~${digest}`;
}
