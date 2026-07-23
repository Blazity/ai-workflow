import type {
  ManualDispatchInput,
  ManualDispatchRequest,
} from "@shared/contracts";
import { createError } from "h3";
import { ManualDispatchError } from "./errors.js";

export function parseManualDispatchInput(value: unknown): ManualDispatchInput {
  if (!value || typeof value !== "object") {
    throw createError({ statusCode: 400, statusMessage: "Invalid dispatch input" });
  }
  const input = value as Record<string, unknown>;
  if (
    input.kind === "ticket" &&
    typeof input.ticketKey === "string" &&
    input.ticketKey.trim().length > 0
  ) {
    return { kind: "ticket", ticketKey: input.ticketKey.trim() };
  }
  if (
    input.kind === "pull_request" &&
    typeof input.url === "string" &&
    input.url.trim().length > 0
  ) {
    return { kind: "pull_request", url: input.url.trim() };
  }
  throw createError({ statusCode: 400, statusMessage: "Invalid dispatch input" });
}

export function parseManualDispatchRequest(value: unknown): ManualDispatchRequest {
  if (!value || typeof value !== "object") {
    throw createError({ statusCode: 400, statusMessage: "Invalid dispatch request" });
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      request.requestId,
    ) ||
    typeof request.expectedDeployedVersion !== "number" ||
    !Number.isInteger(request.expectedDeployedVersion) ||
    request.expectedDeployedVersion <= 0
  ) {
    throw createError({ statusCode: 400, statusMessage: "Invalid dispatch request" });
  }
  return {
    requestId: request.requestId,
    expectedDeployedVersion: request.expectedDeployedVersion,
    input: parseManualDispatchInput(request.input),
  };
}

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
