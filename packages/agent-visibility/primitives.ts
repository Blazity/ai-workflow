/**
 * The small shapes every record here is built from, spelled once.
 */
import { z } from "zod";
import {
  AGENT_VISIBILITY_HASH_MAX_LENGTH,
  AGENT_VISIBILITY_ID_MAX_LENGTH,
  AGENT_VISIBILITY_JOIN_KEY_MAX_BYTES,
  AGENT_VISIBILITY_KEY_MAX_LENGTH,
  AGENT_VISIBILITY_TIMESTAMP_MAX_LENGTH,
} from "./limits";
import { jsonBytes, splitsSurrogatePair, wellFormed } from "./text";
import { visibilitySlugSchema } from "./vocabulary";

export const byteCountSchema = z.number().int().min(0);

/** A run id, node id, activation scope id, clarification id or block type. */
export const visibilityIdSchema = z.string().min(1).max(AGENT_VISIBILITY_ID_MAX_LENGTH);

/** ISO 8601. */
export const visibilityTimestampSchema = z.string().min(1).max(AGENT_VISIBILITY_TIMESTAMP_MAX_LENGTH);

/** Lower-case hex, as the compiler spells its own hashes. */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: "must be a sha256 in 64 lower-case hex characters" });

/**
 * A repository key as a READER takes it: a bounded string. The write side
 * checks `repositoryKeySchema` from `@shared/contracts`, whose provider list is
 * closed; a reader that used it would refuse a whole briefing the day a newer
 * worker names a repository on a provider this build does not know.
 */
export const repositoryKeyReadSchema = z.string().min(1).max(AGENT_VISIBILITY_KEY_MAX_LENGTH);

/** A hash as the compiler spells it. The alphabet keeps it one byte a
 *  character on a page. */
export const hashSchema = z.string().regex(new RegExp(`^[A-Za-z0-9+/=:._-]{0,${AGENT_VISIBILITY_HASH_MAX_LENGTH}}$`), {
  message: `must be a hash: letters, digits and +/=:._- only, at most ${AGENT_VISIBILITY_HASH_MAX_LENGTH}`,
});

/** Bytes a join key costs as a JSON string on a page, quotes left out. */
export function joinKeyBytes(key: string): number {
  return jsonBytes(key) - 2;
}

/**
 * A join key as stored: `id` whole, or null with `idWithheld` giving why
 * (`WITHHELD_KEY_REASONS`, read as a slug) and the length and sha256 of the
 * key as given, so a reader holding the key can still match it. Never a cut
 * or redacted key, which would join to the wrong thing or to nothing.
 */
export const joinKeyFields = {
  id: z
    .string()
    .refine((key) => joinKeyBytes(key) <= AGENT_VISIBILITY_JOIN_KEY_MAX_BYTES, {
      message: `a stored key is at most ${AGENT_VISIBILITY_JOIN_KEY_MAX_BYTES} bytes as JSON; a longer one is withheld`,
    })
    .nullable(),
  idWithheld: z
    .object({ reason: visibilitySlugSchema, lengthUtf16: z.number().int().min(1), sha256: sha256HexSchema })
    .optional(),
};

/** `id` and `idWithheld` say one thing: exactly one of them is present. */
export function checkJoinKey(value: { id: string | null; idWithheld?: unknown }, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if ((value.id === null) !== (value.idWithheld !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a key is stored whole in id, or as null with idWithheld, never both",
      path: [...path, "id"],
    });
  }
}

/** Compiles only when `T` is assignable to `U`: how a view here proves it can
 *  still read what the `@shared/contracts` write shape produces. */
export type Assignable<T extends U, U> = T;

/**
 * `text` cut to at most `maxLength` UTF-16 units, saying so: an ellipsis and
 * the full length, so a reader never takes a
 * clamped value for the whole. Never splits a character. `avoid` lists
 * ranges the cut must not land inside (replacement markers).
 */
export function clampText(
  text: string,
  maxLength: number,
  avoid: readonly { start16: number; end16: number }[] = [],
): string {
  const value = wellFormed(text);
  if (value.length <= maxLength) return value;
  const stated = `\u2026 (${value.length} characters in full)`;
  const suffix = stated.length < maxLength ? stated : "\u2026";
  let cut = Math.max(0, maxLength - suffix.length);
  if (splitsSurrogatePair(value, cut)) cut -= 1;
  for (const span of avoid) {
    if (span.start16 < cut && cut < span.end16) cut = span.start16;
  }
  return `${value.slice(0, cut)}${suffix}`;
}
