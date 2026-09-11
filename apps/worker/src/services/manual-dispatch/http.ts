import { createError } from "h3";
import { ManualDispatchError } from "./errors.js";

export function toManualDispatchHttpError(error: unknown): never {
  if (error instanceof ManualDispatchError) {
    throw createError({
      statusCode: error.statusCode,
      statusMessage: error.message,
      data: { code: error.code, message: error.message },
    });
  }
  throw error;
}
