/**
 * The one rule for "the provider said no" versus "the provider said nothing".
 *
 * The expected meaning of each status comes from the providers' own documents,
 * not from running the rule: Jira's statuses endpoint answers 401 for bad
 * credentials and 404 for a project the account cannot see; GitLab answers 401
 * for a token that does not authenticate and 403 for one without the right;
 * GitHub answers a spent rate limit with 403 or 429 and `x-ratelimit-remaining:
 * 0`, and a secondary one with `retry-after`; Slack and Jira answer 429 with
 * `Retry-After`. Everything a connection test gets wrong with this rule lands
 * on a person: a refusal read as an outage leaves a dead token looking fine,
 * and an outage read as a refusal turns a working card Failing.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ConnectionValueError,
  FatalError,
  IssueTrackerNotFoundError,
  readProviderFailure,
  refusedOrThrow,
} from "./index";

function answered(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** The shape Octokit's RequestError has: the status, and the answer's headers lowercased. */
function octokitError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`HttpError ${status}`), {
    name: "HttpError",
    status,
    response: { status, headers },
  });
}

describe("an answer about the values is a refusal", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    test(`${status}`, () => {
      assert.deepEqual(refusedOrThrow(answered(status), "Check the token."), {
        ok: false,
        reason: "Check the token.",
      });
      assert.equal(readProviderFailure(octokitError(status)).kind, "refused");
    });
  }

  test("without a reason of its own, the provider's words are the reason", () => {
    const error = octokitError(401);
    assert.deepEqual(refusedOrThrow(error), { ok: false, reason: error.message });
  });

  test("the SDK's own words for a verdict count as one", () => {
    assert.equal(readProviderFailure(new FatalError("bad key")).kind, "refused");
    assert.equal(
      readProviderFailure(new IssueTrackerNotFoundError("Project", "AIW")).kind,
      "refused",
    );
  });
});

describe("anything that is not an answer about the values is no verdict", () => {
  // 425 is Too Early: RFC 8470 says a user agent "SHOULD retry automatically".
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    test(`${status}`, () => {
      assert.throws(() => refusedOrThrow(answered(status), "Check the token."), /says nothing/u);
      assert.equal(readProviderFailure(octokitError(status)).kind, "no_verdict");
    });
  }

  test("GitHub's 403 for a spent rate limit, in both spellings", () => {
    assert.equal(
      readProviderFailure(answered(403, { "x-ratelimit-remaining": "0" })).kind,
      "no_verdict",
    );
    assert.equal(readProviderFailure(answered(403, { "retry-after": "60" })).kind, "no_verdict");
    assert.equal(
      readProviderFailure(octokitError(403, { "x-ratelimit-remaining": "0" })).kind,
      "no_verdict",
    );
    // A 403 with requests left is a permission the key lacks.
    assert.equal(
      readProviderFailure(answered(403, { "x-ratelimit-remaining": "4999" })).kind,
      "refused",
    );
  });

  test("GitHub's secondary rate limit, which only its message marks", () => {
    // GitHub: a secondary limit is a 403 or 429 "and an error message that
    // indicates that you exceeded a secondary rate limit"; its own client
    // (@octokit/plugin-throttling) recognises it by /\bsecondary rate\b/i.
    const secondary = Object.assign(
      new Error(
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      ),
      { status: 403, response: { status: 403, headers: { "x-ratelimit-remaining": "4870" } } },
    );
    assert.equal(readProviderFailure(secondary).kind, "no_verdict");
    assert.throws(() => refusedOrThrow(secondary), (thrown) => thrown === secondary);
  });

  test("a request that never got a status is rethrown as it was", () => {
    const unreachable = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    });
    assert.throws(
      () => refusedOrThrow(unreachable),
      (thrown) => thrown === unreachable,
    );
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    assert.equal(readProviderFailure(timeout).kind, "no_verdict");
    // Octokit wraps a failed fetch in a RequestError with status 500.
    assert.equal(readProviderFailure(octokitError(500)).kind, "no_verdict");
  });

  test("a body that does not parse is no verdict", () => {
    assert.equal(
      readProviderFailure(new SyntaxError("Unexpected token < in JSON")).kind,
      "no_verdict",
    );
  });
});

describe("values that could not form a request are refused, not an outage", () => {
  test("a value core refused before sending, in its own words", () => {
    const refusal = new ConnectionValueError(
      "apiToken",
      "The API token has a line break in it, which no request can carry. Enter it again as one line.",
    );
    assert.deepEqual(refusedOrThrow(refusal, "Jira did not accept the token."), {
      ok: false,
      reason:
        "The API token has a line break in it, which no request can carry. Enter it again as one line.",
      malformed: true,
    });
  });

  test("a URL the platform could not parse, on the error or on its cause", () => {
    const invalid = thrownBy(() => new URL("acme.atlassian.net"));
    assert.deepEqual(readProviderFailure(invalid), {
      kind: "refused",
      status: null,
      malformed: true,
      message: (invalid as Error).message,
    });
    const fromFetch = new TypeError("Failed to parse URL from gitlab.com/api/v4/user", {
      cause: invalid,
    });
    assert.equal(refusedOrThrow(fromFetch).malformed, true);
  });

  test("key data WebCrypto could not import", () => {
    const rejected = new DOMException("Invalid keyData", "DataError");
    assert.equal(refusedOrThrow(rejected).malformed, true);
  });

  test("a network failure stays no verdict, a missing host included", () => {
    // Deliberate: ENOTFOUND is also what a VPN that is down says about a host
    // that exists. Core names the host and the field instead.
    const notFound = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND gitlab.acme.internal"), {
        code: "ENOTFOUND",
      }),
    });
    assert.equal(readProviderFailure(notFound).kind, "no_verdict");
  });
});

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, and it returned");
}
