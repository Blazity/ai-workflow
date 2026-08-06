import type { WebhookAuthScheme, WorkflowBlockType } from "@shared/contracts";
import { WEBHOOK_AUTH_SCHEMES } from "@shared/contracts";
import { and, eq, getTableColumns, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { webhookTriggerEndpoints } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookEndpointId,
  generateWebhookSecret,
  WebhookSecretKeyMismatchError,
} from "../lib/webhook-crypto.js";

/**
 * Endpoint rows for webhook trigger nodes: minting, rotation, revocation, and
 * the decrypt side the delivery path verifies against.
 *
 * A signing secret exists in cleartext exactly four times going OUT: in the
 * response that minted it, in the response that rotated it, in the response that
 * revived a revoked endpoint, and in the reveal a role-gated route performs on
 * request. It also arrives cleartext ONE way IN: setWebhookEndpointSecret
 * receives a caller-supplied secret (a sender that signs with its own value), and
 * encrypts it at rest on the same terms. It is never logged, never put in an
 * error message, and never stored outside secret_ciphertext /
 * previous_secret_ciphertext. Every ciphertext is bound to its own endpoint id,
 * so each call below decrypts with the id of the row it read.
 *
 * Rotation keeps the outgoing secret valid for a fixed window so an operator can
 * update the sending system without a failed delivery. The window is measured on
 * the database clock, so concurrent workers never disagree about when it closes.
 */

const ROTATION_WINDOW = sql`now() + interval '24 hours'`;

export type WebhookEndpointRow = typeof webhookTriggerEndpoints.$inferSelect;

/** The node fields minting reads. Structural on purpose: a caller can pass a
 *  stored graph's nodes without narrowing v1 from v2, since a webhook trigger
 *  only exists in a v2 graph and a v1 node simply never matches the type. */
export interface MintableWebhookNode {
  id: string;
  type: WorkflowBlockType;
  configuration?: Record<string, unknown>;
}

export interface MintedWebhookEndpoint {
  endpointId: string;
  nodeId: string;
  /** True when this call created the row. */
  minted: boolean;
  /** Cleartext, returned only for a row this call created, and only here. */
  secret: string | null;
}

export interface WebhookSecretRotation {
  endpointId: string;
  /** Cleartext, returned exactly once. */
  secret: string;
  previousExpiresAt: Date;
}

/** No previousExpiresAt: reviving a revoked endpoint accepts nothing but the
 *  secret it returns. */
export interface WebhookEndpointRevival {
  endpointId: string;
  /** Cleartext, returned exactly once. */
  secret: string;
}

export interface WebhookSecretCandidate {
  secret: string;
  verifiedWith: "current" | "previous";
}

/** The bounds an imported secret must satisfy. A minimum keeps an operator from
 *  installing a trivially guessable universal key; the maximum is a sanity cap.
 *  No character-set rule: senders dictate arbitrary hex or base64. */
const IMPORTED_SECRET_MIN_LENGTH = 16;
const IMPORTED_SECRET_MAX_LENGTH = 200;

/** An imported secret failed the length rule. The API layer maps this to 400.
 *  The message names the rule only, never the value the caller sent. */
export class WebhookSecretInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSecretInvalidError";
  }
}

/** A rotation window is still open. Rotating again would evict the secret the
 *  previous rotation promised to keep accepting, so the caller must either wait
 *  or say `force` explicitly. The API layer maps this to 409. */
export class WebhookRotationInFlightError extends Error {
  readonly previousExpiresAt: Date;

  constructor(previousExpiresAt: Date) {
    super(
      `A replaced webhook secret is still accepted until ${previousExpiresAt.toISOString()}; rotate with force to evict it`,
    );
    this.name = "WebhookRotationInFlightError";
    this.previousExpiresAt = previousExpiresAt;
  }
}

/**
 * Give every webhook trigger node in a definition's live head an endpoint row.
 * Idempotent: a node that already has an endpoint keeps its id, its secret, and
 * its revocation, so re-deploying neither breaks a sender that is already
 * configured nor revives an endpoint an operator took out of service. Bringing a
 * revoked endpoint back is unrevokeWebhookEndpoint, an explicit operator action.
 *
 * Without an encryption key the feature is not configured and this is a no-op,
 * which is also why every caller can invoke it unconditionally.
 */
export async function mintWebhookEndpointsForDefinition(
  db: Db,
  keyHex: string | undefined,
  input: { definitionId: number; nodes: readonly MintableWebhookNode[] },
): Promise<MintedWebhookEndpoint[]> {
  if (!keyHex) return [];
  const results: MintedWebhookEndpoint[] = [];
  for (const node of input.nodes) {
    if (node.type !== "trigger_webhook") continue;
    // The id is minted first because the ciphertext is bound to it: a secret
    // encrypted here cannot be transplanted into another endpoint's row.
    const candidateId = generateWebhookEndpointId();
    const secret = generateWebhookSecret();
    const headerName = headerNameOf(node);
    const authScheme = authSchemeOf(node);
    const requireTimestamp = requireTimestampOf(node);
    const timestampHeader = timestampHeaderOf(node);
    const timestampTolerance = timestampToleranceOf(node);
    const rows = await db
      .insert(webhookTriggerEndpoints)
      .values({
        id: candidateId,
        definitionId: input.definitionId,
        nodeId: node.id,
        ...(authScheme ? { authScheme } : {}),
        ...(headerName ? { headerName } : {}),
        requireTimestamp,
        ...(timestampHeader ? { timestampHeader } : {}),
        timestampToleranceSeconds: timestampTolerance ?? 300,
        secretCiphertext: encryptWebhookSecret(secret, keyHex, candidateId),
      })
      .onConflictDoUpdate({
        target: [webhookTriggerEndpoints.definitionId, webhookTriggerEndpoints.nodeId],
        // Re-sync the node-authored auth scheme and header override, exactly the
        // draft -> deploy path every other block parameter follows. Every value
        // is written concretely (not spread-in) so clearing a flag or override in
        // the draft turns it back off on redeploy, the same way headerName
        // re-syncs to null. The stored secrets, an in-flight rotation window, and
        // above all revoked_at survive a re-deploy: the row owns those once it
        // exists, and a revocation a deploy could undo would be no revocation at all.
        set: {
          authScheme: authScheme ?? "hmac_sha256",
          headerName,
          requireTimestamp,
          timestampHeader,
          timestampToleranceSeconds: timestampTolerance ?? 300,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("webhook endpoint row disappeared after upsert");
    // The candidate id is random, so seeing it back means this call inserted.
    const minted = row.id === candidateId;
    results.push({
      endpointId: row.id,
      nodeId: node.id,
      minted,
      secret: minted ? secret : null,
    });
  }
  return results;
}

export async function getWebhookEndpointById(
  db: Db,
  endpointId: string,
): Promise<WebhookEndpointRow | null> {
  const rows = await db
    .select()
    .from(webhookTriggerEndpoints)
    .where(eq(webhookTriggerEndpoints.id, endpointId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The endpoint plus the database's own clock, in one round trip. The delivery
 * path filters the rotation window against this instead of the app clock,
 * because previousExpiresAt is written on now() (the DB clock): a worker whose
 * clock runs fast must not keep accepting a replaced secret past its expiry.
 */
export async function readWebhookEndpointForDelivery(
  db: Db,
  endpointId: string,
): Promise<{ endpoint: WebhookEndpointRow; dbNow: Date } | null> {
  const rows = await db
    .select({ ...getTableColumns(webhookTriggerEndpoints), dbNow: sql<string>`now()` })
    .from(webhookTriggerEndpoints)
    .where(eq(webhookTriggerEndpoints.id, endpointId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { dbNow, ...endpoint } = row;
  // Raw now() comes back untyped by the driver; normalize to a Date so the
  // window comparison is Date vs Date on both pglite and neon-http.
  return { endpoint, dbNow: new Date(dbNow) };
}

export async function getWebhookEndpointForNode(
  db: Db,
  definitionId: number,
  nodeId: string,
): Promise<WebhookEndpointRow | null> {
  const rows = await db
    .select()
    .from(webhookTriggerEndpoints)
    .where(
      and(
        eq(webhookTriggerEndpoints.definitionId, definitionId),
        eq(webhookTriggerEndpoints.nodeId, nodeId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Replace the signing secret, keeping the outgoing one valid for the rotation
 * window. Returns null when there is no such endpoint, and throws
 * WebhookRotationInFlightError when a window is already open: a second rotation
 * would silently evict the secret the first one is still promising to accept.
 * `force` is the operator saying that is what they want (a leaked secret).
 */
export async function rotateWebhookEndpointSecret(
  db: Db,
  keyHex: string,
  endpointId: string,
  options: { force?: boolean } = {},
): Promise<WebhookSecretRotation | null> {
  const secret = generateWebhookSecret();
  const rows = await db
    .update(webhookTriggerEndpoints)
    .set({
      secretCiphertext: encryptWebhookSecret(secret, keyHex, endpointId),
      // Evaluated against the pre-update row, so this is the outgoing secret.
      // It stays inside its own row, so the id it is bound to still matches.
      previousSecretCiphertext: sql`${webhookTriggerEndpoints.secretCiphertext}`,
      previousExpiresAt: ROTATION_WINDOW,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(webhookTriggerEndpoints.id, endpointId),
        options.force
          ? undefined
          // A null expiry alongside a stored previous secret is unreachable
          // through this module, but treating it as "no window" self-heals the
          // row instead of blocking every rotation on it forever.
          : sql`(${webhookTriggerEndpoints.previousSecretCiphertext} IS NULL
                 OR ${webhookTriggerEndpoints.previousExpiresAt} IS NULL
                 OR ${webhookTriggerEndpoints.previousExpiresAt} <= now())`,
      ),
    )
    .returning();
  const updated = rows[0];
  if (!updated) {
    const existing = await getWebhookEndpointById(db, endpointId);
    if (!existing) return null;
    throw new WebhookRotationInFlightError(existing.previousExpiresAt!);
  }
  return {
    endpointId: updated.id,
    secret,
    previousExpiresAt: updated.previousExpiresAt!,
  };
}

/**
 * Replace the signing secret with a value the caller supplies, for a sender that
 * signs with its OWN secret rather than one this endpoint minted (Sentry's
 * Internal Integration Client Secret is the motivating case). Unlike a rotation
 * there is no dual-accept window: importing means "verify with exactly this from
 * now on", so the previously minted secret stops working the instant this
 * returns, which is the operator's explicit intent.
 *
 * The plaintext is validated for length only; the character set is left free
 * because senders dictate arbitrary hex or base64. It is encrypted at rest
 * immediately, bound to this endpoint id as AAD, and never logged or echoed.
 *
 * Returns the updated row, or null for an unknown id. Leaves revoked_at alone,
 * exactly like rotate: a revoked endpoint is refused at the route, not here.
 */
export async function setWebhookEndpointSecret(
  db: Db,
  keyHex: string,
  endpointId: string,
  plaintextSecret: string,
): Promise<WebhookEndpointRow | null> {
  const secret = plaintextSecret.trim();
  if (
    secret.length < IMPORTED_SECRET_MIN_LENGTH ||
    secret.length > IMPORTED_SECRET_MAX_LENGTH
  ) {
    throw new WebhookSecretInvalidError(
      `Imported webhook secret must be between ${IMPORTED_SECRET_MIN_LENGTH} and ${IMPORTED_SECRET_MAX_LENGTH} characters after trimming`,
    );
  }
  const rows = await db
    .update(webhookTriggerEndpoints)
    .set({
      secretCiphertext: encryptWebhookSecret(secret, keyHex, endpointId),
      // A hard replace, not a rotation: the old minted secret dies now, so there
      // is nothing to keep accepting for a window.
      previousSecretCiphertext: null,
      previousExpiresAt: null,
      updatedAt: sql`now()`,
    })
    // Atomically skip a revoked endpoint: a concurrent revoke between the route's
    // pre-read and this update must not land a secret on a row taken out of
    // service. No row updated then returns null, and the route refuses.
    .where(
      and(
        eq(webhookTriggerEndpoints.id, endpointId),
        isNull(webhookTriggerEndpoints.revokedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Current cleartext secret. A minted secret is shown once and an operator who
 * missed it would otherwise have to rotate (and break the sender) just to read
 * it. The route layer role-gates and audits this call.
 */
export async function revealWebhookEndpointSecret(
  db: Db,
  keyHex: string,
  endpointId: string,
): Promise<string | null> {
  const endpoint = await getWebhookEndpointById(db, endpointId);
  if (!endpoint) return null;
  return decryptWebhookSecret(endpoint.secretCiphertext, keyHex, endpoint.id);
}

/** Stop accepting deliveries without deleting the endpoint's history. Keeps the
 *  first revocation instant if the endpoint is already revoked. Terminal until
 *  an operator calls unrevokeWebhookEndpoint: no deploy undoes it. */
export async function revokeWebhookEndpoint(db: Db, endpointId: string): Promise<void> {
  await db
    .update(webhookTriggerEndpoints)
    .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(webhookTriggerEndpoints.id, endpointId),
        isNull(webhookTriggerEndpoints.revokedAt),
      ),
    );
}

/**
 * Bring a revoked endpoint back into service on a brand new secret, with every
 * older secret dead the instant it revives. Revocation presumes the credential
 * is compromised, so this path has no dual-accept window: the rotation window
 * exists for a planned rotation, where the sender is trusted and just needs time
 * to be updated. Reviving instead means the sender must be reconfigured, and
 * until it is, a delivery signed with the leaked secret is refused.
 *
 * One statement, so an endpoint is never briefly live under an old secret.
 * Returns the new cleartext exactly once, or null when there is no such endpoint
 * OR the endpoint is not revoked (the route distinguishes those two by a pre-read).
 */
export async function unrevokeWebhookEndpoint(
  db: Db,
  keyHex: string,
  endpointId: string,
): Promise<WebhookEndpointRevival | null> {
  const secret = generateWebhookSecret();
  const rows = await db
    .update(webhookTriggerEndpoints)
    .set({
      revokedAt: null,
      secretCiphertext: encryptWebhookSecret(secret, keyHex, endpointId),
      previousSecretCiphertext: null,
      previousExpiresAt: null,
      updatedAt: sql`now()`,
    })
    // Only a still-revoked row revives here: the update and the "was it revoked"
    // check are one statement, so two concurrent revivals cannot both mint a new
    // secret. A live row returns nothing, which the route maps to 409.
    .where(
      and(
        eq(webhookTriggerEndpoints.id, endpointId),
        isNotNull(webhookTriggerEndpoints.revokedAt),
      ),
    )
    .returning({ id: webhookTriggerEndpoints.id });
  const updated = rows[0];
  if (!updated) return null;
  return { endpointId: updated.id, secret };
}

/**
 * Every secret a delivery may legitimately be signed with, newest first. The
 * replaced secret is offered only while its window is open, so a rotation that
 * has expired rejects the old sender instead of accepting it forever.
 *
 * A decrypt failure on the CURRENT secret is not caught: it means "this row
 * cannot be trusted", which the caller reports as a decrypt failure, never as an
 * invalid signature. A key mismatch on the PREVIOUS secret is different: the env
 * key was rotated and this endpoint's secret was rotated afterward, so the new
 * current ciphertext is under the new key while the outgoing one is still under
 * the old. Dropping the un-decryptable previous keeps the endpoint alive on its
 * current secret instead of bricking it; the window closes on its own.
 *
 * `now` must be the database clock (see readWebhookEndpointForDelivery), because
 * previousExpiresAt was stamped on now(): an app clock running fast would
 * otherwise keep offering a replaced secret past its promised expiry.
 */
export function decryptCandidateSecrets(
  endpoint: Pick<
    WebhookEndpointRow,
    "id" | "secretCiphertext" | "previousSecretCiphertext" | "previousExpiresAt"
  >,
  keyHex: string,
  now: Date = new Date(),
): WebhookSecretCandidate[] {
  const candidates: WebhookSecretCandidate[] = [
    {
      secret: decryptWebhookSecret(endpoint.secretCiphertext, keyHex, endpoint.id),
      verifiedWith: "current",
    },
  ];
  if (
    endpoint.previousSecretCiphertext &&
    endpoint.previousExpiresAt &&
    endpoint.previousExpiresAt > now
  ) {
    try {
      candidates.push({
        secret: decryptWebhookSecret(
          endpoint.previousSecretCiphertext,
          keyHex,
          endpoint.id,
        ),
        verifiedWith: "previous",
      });
    } catch (error) {
      // Only a key mismatch on the outgoing secret is survivable. A decryption
      // error on it (malformed or tampered under the current key) is still real
      // drift and propagates like the current secret would.
      if (!(error instanceof WebhookSecretKeyMismatchError)) throw error;
      logger.warn(
        { endpointId: endpoint.id },
        "webhook_previous_secret_key_mismatch_dropped",
      );
    }
  }
  return candidates;
}

/** Authored scheme, or undefined to let the column default stand. */
function authSchemeOf(node: MintableWebhookNode): WebhookAuthScheme | undefined {
  const value = node.configuration?.authScheme;
  return WEBHOOK_AUTH_SCHEMES.includes(value as WebhookAuthScheme)
    ? (value as WebhookAuthScheme)
    : undefined;
}

/** Null (an absent override) means "the scheme's default header name". */
function headerNameOf(node: MintableWebhookNode): string | null {
  const value = node.configuration?.headerName;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Off unless the node explicitly authored `requireTimestamp: true`. */
function requireTimestampOf(node: MintableWebhookNode): boolean {
  return node.configuration?.requireTimestamp === true;
}

/** Null (an absent override) means "the default timestamp header name". */
function timestampHeaderOf(node: MintableWebhookNode): string | null {
  const value = node.configuration?.timestampHeader;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The authored tolerance, or undefined to let the column default (300) stand.
 *  An out-of-range value is filtered out here so a bad draft never stores a row
 *  the tolerance CHECK would reject. Bounds mirror the config validator (30..900). */
function timestampToleranceOf(node: MintableWebhookNode): number | undefined {
  const value = node.configuration?.timestampToleranceSeconds;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 30 &&
    value <= 900
    ? value
    : undefined;
}
