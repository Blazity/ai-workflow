import { z } from "zod";

/**
 * The bodies the integrations API accepts.
 *
 * Refusal sentences are part of the contract: they are what a screen shows when
 * a request is wrong, so they are written here rather than left to zod's
 * defaults.
 */

/** Values are strings on the wire whatever the field's format is; the worker
 *  turns an `integer` field into a number when it resolves the connection, so
 *  the same body works for a text input and a number input. */
const connectionValues = z.record(
  z.string(),
  // Generous enough for a PEM private key, bounded so a request cannot carry a
  // file. Nothing a provider calls a credential comes near this.
  z.string().max(8192, { message: "a connection value must be 8192 characters or fewer" }),
);

export const integrationConnectionSaveRequestSchema = z.object({
  /** The `latestVersion` the screen last read. 0 means "nothing was ever saved
   *  here", which is what a first connect carries. */
  expectedVersion: z
    .number({ message: "expectedVersion must be a number" })
    .int({ message: "expectedVersion must be a whole number" })
    .min(0, { message: "expectedVersion must not be negative" }),
  /** Only the fields this save carries. A secret left out keeps its stored
   *  value, which is what lets an admin correct a URL without retyping a token. */
  values: connectionValues.default({}),
  /** Secret fields to empty. Its own list, because clearing a credential must be
   *  something an admin asked for rather than something a blank input did. */
  clearSecrets: z.array(z.string()).default([]),
});

export type IntegrationConnectionSaveRequest = z.infer<
  typeof integrationConnectionSaveRequestSchema
>;

export const integrationSourceRequestSchema = z.object({
  source: z.enum(["environment", "stored"], {
    message: "source must be environment or stored",
  }),
});

export type IntegrationSourceRequest = z.infer<typeof integrationSourceRequestSchema>;

export const integrationEnabledRequestSchema = z.object({
  enabled: z.boolean({ message: "enabled must be true or false" }),
});

export type IntegrationEnabledRequest = z.infer<typeof integrationEnabledRequestSchema>;
