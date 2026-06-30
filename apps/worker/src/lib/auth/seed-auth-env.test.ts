import { describe, expect, it } from "vitest";

import { resolveSeedAuthEnv } from "./seed-auth-env.js";

describe("resolveSeedAuthEnv", () => {
  it("treats whitespace-only required values as missing", () => {
    const resolved = resolveSeedAuthEnv({
      DATABASE_URL: " postgres://example ",
      BETTER_AUTH_SECRET: " ",
      BETTER_AUTH_URL: "\t",
      DASHBOARD_AUTH_EMAIL: " admin@example.com ",
      DASHBOARD_AUTH_PASSWORD: "\n",
    });

    expect(resolved.missingRequiredEnv).toEqual([
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "DASHBOARD_ORIGIN",
      "DASHBOARD_AUTH_PASSWORD",
    ]);
    expect(resolved.values.DATABASE_URL).toBe("postgres://example");
    expect(resolved.values.DASHBOARD_AUTH_EMAIL).toBe("admin@example.com");
  });
});
