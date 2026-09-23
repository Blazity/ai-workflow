/**
 * Which refusal of a pull request read closes a delivery for good. The shapes
 * are each client's own: Octokit's `RequestError` (status, `response.headers`,
 * a message that starts with GitHub's), Gitbeaker 43.8.0's (no status, the
 * answer on `cause.response`, GitLab's `error` on `cause.description`), and a
 * bare `Response`. The expected answers come from the providers' documents:
 * GitHub's REST troubleshooting page ("Resource not accessible" is a token
 * without the endpoint's permission), GitLab's REST authentication page (the
 * `insufficient_scope` 403 body) and RFC 6750, 3.1.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPullRequestRefusal, providerAnswer } from "./index";

function octokit(status: number, message: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), { status, response: { headers } });
}

function gitbeaker(status: number, description: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(description), {
    cause: { description, response: new Response(null, { status, headers }) },
  });
}

test("a pull request that is gone, or forbidden to it alone, is unreadable for good", () => {
  assert.equal(isPullRequestRefusal(octokit(404, "Not Found")), true);
  assert.equal(isPullRequestRefusal(gitbeaker(404, "404 Not found")), true);
  assert.equal(isPullRequestRefusal(gitbeaker(403, "403 Forbidden")), true);
  assert.equal(isPullRequestRefusal(new Response(null, { status: 404 })), true);
});

test("a credential refused as a whole is the connection's fault, not this pull request's", () => {
  assert.equal(isPullRequestRefusal(octokit(401, "Bad credentials")), false);
  assert.equal(
    isPullRequestRefusal(octokit(403, "Resource not accessible by integration - https://docs.github.com/rest")),
    false,
  );
  assert.equal(isPullRequestRefusal(gitbeaker(403, "insufficient_scope")), false);
  assert.equal(
    isPullRequestRefusal(
      new Response(null, {
        status: 403,
        headers: { "www-authenticate": 'Bearer realm="api", error="insufficient_scope", scope="read_api"' },
      }),
    ),
    false,
  );
});

test("a rate limit and a provider that did not answer are no verdict at all", () => {
  assert.equal(isPullRequestRefusal(octokit(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0" })), false);
  assert.equal(isPullRequestRefusal(gitbeaker(429, "429 Too Many Requests")), false);
  assert.equal(isPullRequestRefusal(gitbeaker(502, "502 Bad Gateway")), false);
  assert.equal(isPullRequestRefusal(new Error("socket hang up")), false);
});

test("the answer is read where each client keeps it", () => {
  assert.deepEqual(providerAnswer(octokit(404, "Not Found", { "x-ratelimit-remaining": "12" })), {
    status: 404,
    headers: { "x-ratelimit-remaining": "12" },
  });
  assert.deepEqual(providerAnswer(gitbeaker(401, "401 Unauthorized", { "retry-after": "30" })), {
    status: 401,
    headers: { "retry-after": "30" },
  });
  assert.equal(providerAnswer(new Error("socket hang up")), null);
});
