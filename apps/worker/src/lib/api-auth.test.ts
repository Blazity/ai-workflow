import { describe, it, expect } from "vitest";

import { verifyApiToken } from "./api-auth.js";

const TOKEN = "s3cret-token-value";

/** Assert that calling `fn` throws an h3 error with a 401 status code. */
function expect401(fn: () => void) {
  try {
    fn();
  } catch (err) {
    expect((err as { statusCode?: number }).statusCode).toBe(401);
    return;
  }
  throw new Error("expected verifyApiToken to throw, but it did not");
}

describe("verifyApiToken", () => {
  it("accepts a correct bearer token", () => {
    expect(() => verifyApiToken(`Bearer ${TOKEN}`, TOKEN)).not.toThrow();
  });

  it("is case-insensitive on the scheme name", () => {
    expect(() => verifyApiToken(`bearer ${TOKEN}`, TOKEN)).not.toThrow();
  });

  it("rejects a missing Authorization header", () => {
    expect401(() => verifyApiToken(undefined, TOKEN));
  });

  it("rejects an empty Authorization header", () => {
    expect401(() => verifyApiToken("", TOKEN));
  });

  it("rejects a non-bearer scheme", () => {
    expect401(() => verifyApiToken(`Basic ${TOKEN}`, TOKEN));
  });

  it("rejects a bearer header with no token", () => {
    expect401(() => verifyApiToken("Bearer", TOKEN));
    expect401(() => verifyApiToken("Bearer ", TOKEN));
  });

  it("rejects a wrong token of the same length", () => {
    const wrong = "x".repeat(TOKEN.length);
    expect401(() => verifyApiToken(`Bearer ${wrong}`, TOKEN));
  });

  it("rejects a wrong token of a different length", () => {
    expect401(() => verifyApiToken("Bearer short", TOKEN));
  });
});
