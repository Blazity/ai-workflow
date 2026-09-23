import { defineEventHandler, getRouterParam, createError } from "h3";

import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../../services/auth/request-context.js";
import {
  readIntegrationPageData,
  type IntegrationPageDataResult,
} from "../../../../../../services/integrations/page-data.js";
import { integrationIdFrom } from "../../route-id.js";

/**
 * What one contributed page reads, resolved through that integration's own
 * worker entry.
 *
 * Any signed-in role may read it: a page shows what the provider reports, the
 * same way the health page and the run views do, and it carries no connection
 * value. The write surface of a connection is not reachable from here at all.
 */
export default defineEventHandler(
  async (event): Promise<IntegrationPageDataResult | undefined> => {
    try {
      await requireDashboardActor(event);
      const page = getRouterParam(event, "page");
      if (!page || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(page)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid page id" });
      }
      return await readIntegrationPageData(integrationIdFrom(event), page);
    } catch (error) {
      toHttpError(error);
    }
  },
);
