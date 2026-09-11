/**
 * Runtime request schemas for the prompt-library HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";
import { objectOrEmpty } from "./request-parsing";
import type { PromptSlotDefinition } from "./prompt-slots";

/** The handlers only checked that these were arrays and passed the elements
 *  straight to the store, which validates them itself, so the element check
 *  stays where it already is. */
const slotsField = z
  .array(z.custom<PromptSlotDefinition>(), { invalid_type_error: "Invalid slots" })
  .optional();
const tagsField = z
  .array(z.custom<string>(), { invalid_type_error: "Invalid tags" })
  .optional();

const nameField = z.string({
  required_error: "Invalid name",
  invalid_type_error: "Invalid name",
});
const bodyField = z.string({
  required_error: "Invalid body",
  invalid_type_error: "Invalid body",
});
const descriptionField = z
  .string({ invalid_type_error: "Invalid description" })
  .nullable()
  .optional();

export const promptLibraryCreateRequestSchema = objectOrEmpty(
  z.object({
    name: nameField,
    body: bodyField,
    slots: slotsField,
    description: descriptionField,
    tags: tagsField,
  }),
);
export type PromptLibraryCreateRequest = z.infer<
  typeof promptLibraryCreateRequestSchema
>;

export const promptLibraryUpdateMetaRequestSchema = objectOrEmpty(
  z.object({
    name: nameField.optional(),
    description: descriptionField,
    tags: tagsField,
  }),
);
export type PromptLibraryUpdateMetaRequest = z.infer<
  typeof promptLibraryUpdateMetaRequestSchema
>;

export const promptLibrarySaveVersionRequestSchema = objectOrEmpty(
  z.object({
    body: bodyField,
    slots: slotsField,
  }),
);
export type PromptLibrarySaveVersionRequest = z.infer<
  typeof promptLibrarySaveVersionRequestSchema
>;

/** Versions start at 1 and the column is int4, so a value outside that range
 *  would overflow the query into a 500 rather than a clean refusal. */
export const promptLibraryRestoreRequestSchema = objectOrEmpty(
  z.object({
    version: z
      .number({
        required_error: "Invalid version",
        invalid_type_error: "Invalid version",
      })
      .int({ message: "Invalid version" })
      .min(1, { message: "Invalid version" })
      .max(2147483647, { message: "Invalid version" }),
  }),
);
export type PromptLibraryRestoreRequest = z.infer<
  typeof promptLibraryRestoreRequestSchema
>;
