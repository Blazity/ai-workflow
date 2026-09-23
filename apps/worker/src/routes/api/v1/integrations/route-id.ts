import { INTEGRATION_ID } from "@shared/contracts";
import { createError, getRouterParam, type H3Event } from "h3";

/** The integration id from the path. Whether this build ships one under that id
 *  is the service's answer, not this helper's: a 404 for an unknown integration
 *  and a 400 for a malformed path are different sentences. */
export function integrationIdFrom(event: H3Event): string {
  const id = getRouterParam(event, "id");
  if (!id || !INTEGRATION_ID.test(id)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid integration id" });
  }
  return id;
}
