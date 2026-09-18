import { createError, defineEventHandler, getQuery } from "h3";
import {
  WORK_SCOPE_INT4_MAX,
  WORK_SCOPE_TRAIL_PAGE_MAX,
  workScopeSubjectKeySchema,
  type WorkScopeRecordResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import { readConnectedWorkScopeRecord } from "../../../services/work-scope/index.js";

/** A bounded page number, or undefined when the parameter is absent. Refused
 *  rather than clamped: a caller that asked for a page the store will not serve
 *  is told so instead of being handed a shorter one it did not ask for. */
function pageParam(value: unknown, name: string, max: number): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw createError({
      statusCode: 400,
      statusMessage: `${name} must be a whole number from 1 to ${max}`,
    });
  }
  return parsed;
}

/**
 * The record for one subject: which repositories this work may touch, and the
 * trail of how that was decided.
 *
 * Membership only, no role gate, exactly as the clarification answer route: this
 * is the read a person makes before changing a decision they are entitled to
 * change, and hiding it from the person who made it would leave them editing
 * blind.
 */
export default defineEventHandler(
  async (event): Promise<WorkScopeRecordResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const query = getQuery(event);
      // The same spelling the edit takes, so the two surfaces cannot accept
      // different keys for one record.
      const subject = workScopeSubjectKeySchema.safeParse(query.subjectKey);
      if (!subject.success) {
        throw createError({ statusCode: 400, statusMessage: "subjectKey is required" });
      }
      const limit = pageParam(query.trailLimit, "trailLimit", WORK_SCOPE_TRAIL_PAGE_MAX);
      const beforeId = pageParam(query.trailBefore, "trailBefore", WORK_SCOPE_INT4_MAX);
      // A subject kind that keeps no record answers `carriesRecord: false` and a
      // reason to look no further, rather than an error: the question was fair,
      // and the edit is where that fact refuses a write.
      return await readConnectedWorkScopeRecord({
        subjectKey: subject.data,
        trail: {
          ...(limit === undefined ? {} : { limit }),
          ...(beforeId === undefined ? {} : { beforeId }),
        },
      });
    } catch (error) {
      toHttpError(error);
    }
  },
);
