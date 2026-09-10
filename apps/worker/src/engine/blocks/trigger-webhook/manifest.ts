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
