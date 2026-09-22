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

const integrationConnectionSaveFieldsSchema = z.object({
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
  typeof integrationConnectionSaveFieldsSchema
>;

const integrationSourceFieldSchema = z.enum(["environment", "stored"], {
  message: "source must be environment or stored",
});

/**
 * A read-only consequence preview carried over the connection PUT transport.
 * The dashboard already proxies that path and body; the combined command
 * schema below discriminates on `preview`, so it can never be ignored and
 * fall through into a write.
 *
 * One per change decision 9 asks the impact of: a save (a reconfiguration), a
 * disconnect, a switch of source, and the kill switch. The last two are
 * carried here although their writes are other routes, so the one preview
 * reads definitions and runs one way for all four.
 */
export const integrationImpactPreviewRequestSchema = z.discriminatedUnion("preview", [
  integrationConnectionSaveFieldsSchema.extend({ preview: z.literal("save") }),
  z.object({ preview: z.literal("disconnect") }),
  z.object({ preview: z.literal("source"), source: integrationSourceFieldSchema }),
  z.object({ preview: z.literal("disable") }),
]);

export type IntegrationImpactPreviewRequest = z.infer<
  typeof integrationImpactPreviewRequestSchema
>;

const integrationConnectionCommandSchema = z.discriminatedUnion("preview", [
  integrationConnectionSaveFieldsSchema.extend({ preview: z.literal("write") }),
  integrationConnectionSaveFieldsSchema.extend({ preview: z.literal("save") }),
  z.object({ preview: z.literal("disconnect") }),
  z.object({ preview: z.literal("source"), source: integrationSourceFieldSchema }),
  z.object({ preview: z.literal("disable") }),
]);

/**
 * The one schema parsed by the connection PUT route.
 *
 * The command is required and is never inferred. An earlier shape defaulted a
 * body with no command to a write, which reads as harmless until you say it
 * out loud: a request meant to ask "what would this break" turns into the
 * change itself if one field goes missing between the browser and here. That
 * is the one outcome this whole preview exists to prevent, so the safety sits
 * in the shape of the request rather than in a default. A missing or
 * misspelled command is a 400 that names the ones it could have been.
 */
export const integrationConnectionSaveRequestSchema = integrationConnectionCommandSchema;

export const integrationSourceRequestSchema = z.object({
  source: integrationSourceFieldSchema,
});

export type IntegrationSourceRequest = z.infer<typeof integrationSourceRequestSchema>;

export const integrationEnabledRequestSchema = z.object({
  enabled: z.boolean({ message: "enabled must be true or false" }),
});

export type IntegrationEnabledRequest = z.infer<typeof integrationEnabledRequestSchema>;
