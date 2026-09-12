import { createError, getRouterParam, type H3Event } from "h3";

/**
 * The repository id from the route, refused rather than coerced.
 *
 * A non-numeric segment is a 404 and not a 400: the client asked for a
 * repository that cannot exist, and answering "bad request" would send whoever
 * is reading the log looking at the body instead of the URL.
 */
export function repositoryIdFrom(event: H3Event): number {
  const raw = getRouterParam(event, "id");
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 404, statusMessage: "Unknown repository" });
  }
  return id;
}

/** The same segment where 0 is a legitimate value meaning "not stored yet". */
export function repositoryIdOrNewFrom(event: H3Event): number {
  const raw = getRouterParam(event, "id");
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id < 0) {
    throw createError({ statusCode: 404, statusMessage: "Unknown repository" });
  }
  return id;
}
