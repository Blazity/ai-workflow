import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const webhookPayloadPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.split(".").every(
        (segment) =>
          /^[A-Za-z0-9_-]+$/u.test(segment) &&
          !["__proto__", "prototype", "constructor"].includes(segment),
      ),
    "Payload path contains an empty or unsafe segment.",
  );
// The trigger's optional repository policy. Kept in step by hand with
// `triggerRepositoryPolicySchema` in @shared/contracts, which a manifest may
// import only as a type. Deliberately no default.
const repositoryKey = z
  .string()
  .trim()
  .toLowerCase()
  .max(207)
  .regex(/^[a-z][a-z0-9]{2,31}:[^/\s]+(?:\/[^/\s]+)+$/u);
const repositoryPolicy = z
  .object({
    candidates: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("enabled_catalog") }).strict(),
      z.object({ kind: z.literal("event_repository_and_related") }).strict(),
      z
        .object({
          kind: z.literal("listed"),
          repositoryKeys: z
            .array(repositoryKey)
            .min(1)
            .max(50)
            .refine((keys) => new Set(keys).size === keys.length),
        })
        .strict(),
    ]),
    expansion: z.enum(["attach", "ask_once", "never"]),
  })
  .strict();
const paramsSchema = z
  .object({
    provider: z.enum(["zendesk", "sentry"]).optional(),
    sourceIdPath: webhookPayloadPath.optional(),
    sourceUrlPath: webhookPayloadPath.optional(),
    customerContextPath: webhookPayloadPath.optional(),
    authScheme: z.enum(["hmac_sha256", "shared_token"]).optional(),
    headerName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u)
      .optional(),
    requireTimestamp: z.boolean().optional(),
    timestampHeader: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u)
      .optional(),
    timestampToleranceSeconds: z.number().int().min(30).max(900).optional(),
    subjectPath: webhookPayloadPath.optional(),
    mapSubject: webhookPayloadPath.optional(),
    mapDescription: webhookPayloadPath.optional(),
    mapRequester: webhookPayloadPath.optional(),
    mapPriority: webhookPayloadPath.optional(),
    rateLimitMax: z.number().int().min(1).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
    repositoryPolicy: repositoryPolicy.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.requireTimestamp === true && config.authScheme === "shared_token") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requireTimestamp"],
        message: "Replay protection requires the HMAC SHA-256 scheme.",
      });
    }
  });


export const manifest = {
  type: "trigger_webhook",
  paramsSchema,
  contract: {
    category: "trigger",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "trigger",
    label: "Webhook",
    description: "Starts from a signed webhook delivery sent by an external system (for example Zendesk).",
    glyph: "⇥",
    color: "#D14343",
    softColor: "#FBECEC",
  },
  defaults: {
    authScheme: "hmac_sha256",
    requireTimestamp: false,
    timestampToleranceSeconds: 300,
    mapSubject: "subject",
    mapDescription: "description",
    mapRequester: "requester",
    mapPriority: "priority",
  },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
