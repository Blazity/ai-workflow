import {
  createError,
  defineEventHandler,
  getQuery,
  setResponseHeader,
} from "h3";
import type {
  HarnessCapabilitiesResponse,
  HarnessProvider,
} from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import {
  getHarnessCapabilities,
  HarnessCapabilityCatalogError,
} from "../../../harness-profiles/capability-catalog.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../lib/auth/request-context.js";

export default defineEventHandler(
  async (event): Promise<HarnessCapabilitiesResponse | undefined> => {
    try {
      setResponseHeader(event, "Cache-Control", "private, no-store");
      const actor = await requireDashboardActor(event);
      const query = getQuery(event);
      const provider = parseProvider(query.provider);
      const cliVersion = parseCliVersion(query.cliVersion);
      const refresh =
        query.refresh === "1" || query.refresh === "true";
      return await getHarnessCapabilities(getDb(), {
        organizationId: actor.organizationId,
        provider,
        cliVersion,
        refresh,
      });
    } catch (error) {
      if (error instanceof HarnessCapabilityCatalogError) {
        throw createError({
          statusCode: error.statusCode,
          statusMessage: error.message,
        });
      }
      toHttpError(error);
    }
  },
);

function parseProvider(value: unknown): HarnessProvider {
  if (value !== "claude" && value !== "codex") {
    throw createError({
      statusCode: 400,
      statusMessage: "provider must be claude or codex",
    });
  }
  return value;
}

function parseCliVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "cliVersion must be an exact version",
    });
  }
  return value;
}
