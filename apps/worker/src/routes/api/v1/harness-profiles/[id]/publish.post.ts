import { createError, defineEventHandler, readBody } from "h3";
import {
  harnessProfileRevisionRequestSchema,
  parseRequestBody,
  type HarnessProfilePublishResponse,
} from "@shared/contracts";
import { requireDashboardActor } from "../../../../../services/auth/index.js";
import { publishHarnessProfileDraft } from "../../../../../services/harness/index.js";
import {
  parseHarnessProfileId,
  setHarnessApiNoStore,
  toHarnessProfileHttpError,
} from "../../harness-profiles.get.js";

export default defineEventHandler(
  async (event): Promise<HarnessProfilePublishResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const parsed = parseRequestBody(
        harnessProfileRevisionRequestSchema,
        (await readBody(event).catch(() => null)) ?? {},
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      return publishHarnessProfileDraft({
        profileId: parseHarnessProfileId(event),
        expectedRevision: parsed.value.expectedRevision,
        actor: {
          organizationId: actor.organizationId,
          role: actor.role,
          id: actor.userId,
        },
      });
    } catch (error) {
      toHarnessProfileHttpError(error);
    }
  },
);
