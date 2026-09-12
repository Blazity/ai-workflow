import { createError, defineEventHandler, readBody, setResponseHeader, setResponseStatus } from "h3";
import {
  parseRequestBody,
  repositoryCatalogSuggestRequestSchema,
  type RepositoryCatalogSuggestRateLimited,
  type RepositoryCatalogSuggestResponse,
} from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import {
  RepositorySuggestionRateLimitedError,
  suggestRepositoryProfile,
} from "../../../../services/repository-catalog/index.js";

/**
 * One suggestion for one repository. Nothing is written to the profile by it.
 *
 * **Maximum duration.** This route declares none, because the worker has no way
 * to: `apps/worker/vercel.json` carries only crons, the Nitro config declares no
 * route rules, and the Nitro vercel preset bundles the routes into one function,
 * so a declaration here would move every other route's ceiling with it. The plan
 * asked for 120 seconds and the platform's default of 300 seconds per invocation
 * already covers that.
 *
 * What bounds this call is therefore in the code, and it is **two** bounds, not
 * one: the profile read is capped at 60 seconds for the whole bundle
 * (`REPOSITORY_PROFILE_DEADLINE_MS`, one deadline shared by every request it
 * makes) and the model call at 90 seconds
 * (`REPOSITORY_SUGGESTION_TIMEOUT_MS`), so the worst case is 150 seconds. That
 * sum is what has to stay under the platform's 300, and either bound moving
 * means checking it again: a path that reached the platform ceiling would
 * surface as an opaque kill instead of the retryable 503 these bounds exist to
 * produce.
 *
 * Owner or admin: the call costs money, and a member who could spend it would be
 * spending it on a page they cannot save from.
 */
export default defineEventHandler(
  async (
    event,
  ): Promise<
    RepositoryCatalogSuggestResponse | RepositoryCatalogSuggestRateLimited | undefined
  > => {
    try {
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        repositoryCatalogSuggestRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return await suggestRepositoryProfile({
        actor: { role: actor.role, id: actor.userId },
        repositoryId: parsed.value.repositoryId,
      });
    } catch (error) {
      // A 429 carrying the wait is a body rather than a bare status, the way
      // the activation conflict is: the screen has something useful to say and
      // `toHttpError` can only carry a message. The header is set as well, for
      // the clients that read it there.
      if (error instanceof RepositorySuggestionRateLimitedError) {
        setResponseStatus(event, 429);
        setResponseHeader(event, "Retry-After", error.retryAfterSeconds);
        return {
          error: "suggestion_rate_limited",
          retryAfterSeconds: error.retryAfterSeconds,
        };
      }
      toHttpError(error);
    }
  },
);
