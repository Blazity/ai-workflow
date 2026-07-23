import {
  createError,
  defineEventHandler,
  getQuery,
  getRouterParam,
  setResponseHeader,
  type H3Event,
} from "h3";
import type { HarnessProfilesResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import {
  HarnessProfileStoreError,
  listHarnessProfiles,
} from "../../../harness-profiles/store.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../lib/auth/request-context.js";
import { canManageHarnessProfiles } from "../../../lib/auth/roles.js";

export function parseHarnessProfileId(event: H3Event): string {
  const id = getRouterParam(event, "id");
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  ) {
    throw createError({ statusCode: 404, statusMessage: "Profile not found" });
  }
  return id;
}

export function setHarnessApiNoStore(event: H3Event): void {
  setResponseHeader(event, "Cache-Control", "private, no-store");
}

export function toHarnessProfileHttpError(error: unknown): never {
  if (error instanceof HarnessProfileStoreError) {
    throw createError({
      statusCode: error.statusCode,
      statusMessage: error.message,
      ...(error.details === undefined ? {} : { data: error.details }),
    });
  }
  toHttpError(error);
}

export default defineEventHandler(
  async (event): Promise<HarnessProfilesResponse | undefined> => {
    try {
      setHarnessApiNoStore(event);
      const actor = await requireDashboardActor(event);
      const query = getQuery(event);
      const includeArchived =
        query.includeArchived === "1" || query.includeArchived === "true";
      return {
        profiles: await listHarnessProfiles(getDb(), {
          organizationId: actor.organizationId,
          includeArchived,
        }),
        canManageProfiles: canManageHarnessProfiles(actor.role),
      };
    } catch (error) {
      toHarnessProfileHttpError(error);
    }
  },
);
