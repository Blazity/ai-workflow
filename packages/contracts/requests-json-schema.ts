/**
 * Runtime request schemas for the json-schema HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";
import { objectOrEmpty } from "./request-parsing";

export const jsonSchemaInspectRequestSchema = objectOrEmpty(
  z.object({
    source: z.string({
      required_error: "source must be a JSON Schema string",
      invalid_type_error: "source must be a JSON Schema string",
    }),
  }),
);
export type JsonSchemaInspectRequest = z.infer<typeof jsonSchemaInspectRequestSchema>;
