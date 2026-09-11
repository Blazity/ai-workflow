import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("../../../infra/vcs-config.js", () => ({ env: state.env }));

import { cronRequestIsAuthorized } from "./cron-authorization.js";

/** No header at all, which is what a caller that sends none produces. */
const NO_AUTHORIZATION_HEADER: string | undefined = undefined;

beforeEach(() => {
  for (const key of Object.keys(state.env)) delete state.env[key];
});

describe("cron authorization", () => {
  it("accepts every invocation when no secret is configured", () => {
    // A local or preview worker runs its poll with nothing set, and that is the
    // documented way to run one. An unset secret is an allow, not a deny.
    expect(cronRequestIsAuthorized(NO_AUTHORIZATION_HEADER)).toBe(true);
    expect(cronRequestIsAuthorized("Bearer anything")).toBe(true);
  });

  it("accepts only the configured secret once one is set", () => {
    state.env.CRON_SECRET = "s3cret";

    expect(cronRequestIsAuthorized("Bearer s3cret")).toBe(true);
    expect(cronRequestIsAuthorized("Bearer other")).toBe(false);
    expect(cronRequestIsAuthorized(NO_AUTHORIZATION_HEADER)).toBe(false);
  });

  it("does not accept the bare secret without the bearer scheme", () => {
    // The platform always sends the scheme. Accepting the bare value as well
    // would widen what counts as an authorized invocation for no caller.
    state.env.CRON_SECRET = "s3cret";

    expect(cronRequestIsAuthorized("s3cret")).toBe(false);
  });

  it("is case sensitive about the scheme, as the comparison is exact", () => {
    state.env.CRON_SECRET = "s3cret";

    expect(cronRequestIsAuthorized("bearer s3cret")).toBe(false);
  });
});
