import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import type { WorkScopeEditConflict, WorkScopeEditResponse } from "@shared/contracts";
import { parseRequestBody, workScopeEditRequestSchema } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import { applyConnectedWorkScopeEdit } from "../../../services/work-scope/index.js";

/**
 * A person changing which repositories a subject's work may touch.
 *
 * Membership only, no role gate, and that is the whole authorisation rule: it is
 * the predicate the clarification answer route already enforces ("answering a
 * clarification is a user decision, so every org member may answer",
 * clarifications/[id]/answer.post.ts). The person who excluded a repository by
 * answering one of those questions is usually not an admin, and a recovery path
 * they cannot reach is not a recovery path.
 *
 * `expectedVersion` is the version the caller read. A run or another person
 * writing in between is answered as a conflict carrying the version now in
 * force, never as a silent overwrite: there is no force flag, and the answer to
 * a conflict is always to read the record again.
 *
 * Every selection this route records is recorded without checking that a run can
 * reach the repository, and a later run may still refuse it. The catalog test is
 * real: a `select` naming a repository the catalog does not enable refuses the
 * whole edit. Usability, whether the provider can actually serve the repository,
 * is a fact only a listing carries, and this route lists nothing rather than
 * turning a person's edit into a provider call.
 */
export default defineEventHandler(
  async (event): Promise<WorkScopeEditResponse | WorkScopeEditConflict | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        workScopeEditRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const outcome = await applyConnectedWorkScopeEdit({
        request: parsed.value,
        editor: { id: actor.userId },
      });
      switch (outcome.kind) {
        case "applied":
          return { scope: outcome.scope };
        case "conflict":
          setResponseStatus(event, 409);
          return { error: "version_conflict", latestVersion: outcome.latestVersion };
        case "not_enabled":
          // Names every offending repository, because one rejected change
          // rejects the whole edit and a caller fixing them one at a time would
          // be refused once per repository. The way on is named too, and it is
          // not "enable it yourself": enabling a repository is an owner's or an
          // admin's action on the Repositories page, and the person most likely
          // to be reading this is the member whose exclusion started it.
          throw createError({
            statusCode: 400,
            statusMessage: `The repository catalog does not enable ${outcome.repositoryKeys.join(", ")}, so the whole edit was refused. Ask an owner or an admin to enable it on the Repositories page, or send the edit again without it.`,
          });
        case "subject_carries_no_record":
          throw createError({
            statusCode: 400,
            statusMessage: `${outcome.subjectKey} carries no work scope record, so there is nothing to edit.`,
          });
      }
    } catch (error) {
      toHttpError(error);
    }
  },
);
