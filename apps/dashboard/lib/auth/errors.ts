// apps/dashboard/lib/auth/errors.ts

/** Thrown by getJSON when the worker responds with 401 Unauthorized. */
export class UnauthorizedError extends Error {
  constructor(path: string) {
    super(`GET ${path} → 401 Unauthorized`);
    this.name = "UnauthorizedError";
  }
}

/** Thrown by getJSON when the worker responds with 403 Forbidden. */
export class ForbiddenError extends Error {
  constructor(path: string) {
    super(`GET ${path} → 403 Forbidden`);
    this.name = "ForbiddenError";
  }
}
