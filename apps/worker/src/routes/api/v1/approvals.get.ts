import { createError, defineEventHandler, getQuery } from "h3";
import type { ApprovalsResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  ApprovalStoreError,
  listApprovals,
  serializeApproval,
} from "../../../approvals/store.js";

/** Maps an approval store write failure (409) to its HTTP error, then defers the
 *  rest (403 DashboardAuthError, etc.) to the shared toHttpError. */
export function toApprovalHttpError(error: unknown): never {
  if (error instanceof ApprovalStoreError) {
    throw createError({ statusCode: error.statusCode, statusMessage: error.message });
  }
  toHttpError(error);
}

export default defineEventHandler(async (event): Promise<ApprovalsResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    const status = getQuery(event).status === "all" ? "all" : "pending";
    const approvals = (await listApprovals(getDb(), { status })).map(serializeApproval);
    return { generatedAt: new Date().toISOString(), approvals };
  } catch (error) {
    toApprovalHttpError(error);
  }
});
