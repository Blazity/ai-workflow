import type { IntegrationHttp } from "@integrations/sdk";

/**
 * GitLab's REST API, answered by path, as the context's HTTP a GitLab adapter
 * is built on.
 *
 * The adapter reaches GitLab only through the context it is handed (Gitbeaker
 * included, see `integrations/gitlab/client.ts`), so a test that wants the real
 * adapter on recorded answers states the answers here, at the provider
 * boundary, rather than replacing the client inside the unit it tests.
 * `answer` gets the decoded path (`/api/v4/projects/acme/api/merge_requests/7`)
 * and returns the JSON body, or `undefined` for GitLab's 404.
 */
export function gitLabRestAnswers(answer: (path: string) => unknown): IntegrationHttp {
  return {
    async fetch(input) {
      const url = typeof input === "string" || input instanceof URL ? input : input.url;
      const body = answer(decodeURIComponent(new URL(url).pathname));
      return body === undefined
        ? new Response(JSON.stringify({ message: "404 Not Found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    },
  };
}
