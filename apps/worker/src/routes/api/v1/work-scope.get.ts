import { createError, defineEventHandler, getQuery } from "h3";
import {
  WORK_SCOPE_INT4_MAX,
  WORK_SCOPE_TRAIL_PAGE_MAX,
  workScopeSubjectKeySchema,
  type WorkScopeRecordResponse,
} from "@shared/contracts";
import type { ClarificationRoundHeader } from "@shared/agent-visibility";
import {
  assembleSubjectRounds,
  connectedRoundReads,
  roundHeadersPage,
  type AgentVisibilityPage,
} from "../../../services/agent-visibility/index.js";
import { requireDashboardActor } from "../../../services/auth/request-context.js";
import { readConnectedWorkScopeRecord } from "../../../services/work-scope/index.js";
import { parseListQuery, toBriefingHttpError } from "./runs/briefing-route.js";
import { subjectKeyRefusal } from "./work-scope/subject-key.js";

/**
 * Today's record, plus the clarification rounds when a caller asks for them.
 *
 * `rounds` is ABSENT, not null, on a call that did not ask: a caller from
 * before this existed gets the same object it always got, key for key, which
 * is what "unchanged" has to mean for a shape other people parse.
 */
export type WorkScopeRecordWithRounds = WorkScopeRecordResponse & {
  rounds?: AgentVisibilityPage<ClarificationRoundHeader>;
};

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
 *
 * ROUNDS ARE OPT IN, and that is not a nicety. Assembling one needs every
 * clarification this subject ever carried, the question text runs to tens of
 * kilobytes, and the rounds are read under the RUN's audience rather than this
 * route's. A caller that does not ask for them gets exactly the answer it got
 * before this existed, byte for byte, including its status codes.
 */
export default defineEventHandler(
  async (event): Promise<WorkScopeRecordWithRounds | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const query = getQuery(event);
      // The same spelling the edit takes, so the two surfaces cannot accept
      // different keys for one record.
      const subject = workScopeSubjectKeySchema.safeParse(query.subjectKey);
      if (!subject.success) {
        throw createError({
          statusCode: 400,
          statusMessage: subjectKeyRefusal(query.subjectKey, subject.error),
        });
      }
      const limit = pageParam(query.trailLimit, "trailLimit", WORK_SCOPE_TRAIL_PAGE_MAX);
      const beforeId = pageParam(query.trailBefore, "trailBefore", WORK_SCOPE_INT4_MAX);
      // A subject kind that keeps no record answers `carriesRecord: false` and a
      // reason to look no further, rather than an error: the question was fair,
      // and the edit is where that fact refuses a write.
      const record = await readConnectedWorkScopeRecord({
        subjectKey: subject.data,
        trail: {
          ...(limit === undefined ? {} : { limit }),
          ...(beforeId === undefined ? {} : { beforeId }),
        },
      });
      if (query.rounds !== "true") return record;
      const assembled = await assembleSubjectRounds(connectedRoundReads, {
        subjectKey: subject.data,
        organizationId: actor.organizationId,
      });
      return {
        ...record,
        rounds: roundHeadersPage(assembled, parseRoundsQuery(query)),
      };
    } catch (error) {
      // Maps this route's own refusals first and falls through to the shared
      // dashboard mapping, so a rounds refusal and a session refusal each keep
      // the status they always had.
      toBriefingHttpError(error);
    }
  },
);

/** The rounds page is paged on its own parameters, so `trailLimit` keeps
 *  meaning what it meant and a round's `effectCount` owes it nothing. */
function parseRoundsQuery(query: Record<string, unknown>): { cursor?: string; limit?: number } {
  return parseListQuery({ cursor: query.roundsCursor, limit: query.roundsLimit });
}
