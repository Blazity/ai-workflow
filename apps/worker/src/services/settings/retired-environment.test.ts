import { describe, expect, it } from "vitest";
import { RETIRED_ENVIRONMENT_VARIABLES } from "@shared/contracts";
import { assertNoRetiredEnvironmentVariables } from "./retired-environment.js";

describe("retired settings environment guard", () => {
  it("names every retired variable and points the operator to the removal guide", () => {
    const environment = Object.fromEntries(
      RETIRED_ENVIRONMENT_VARIABLES.map((name) => [name, "set"]),
    );

    expect(() => assertNoRetiredEnvironmentVariables(environment)).toThrow(
      `Retired settings variables are still set: ${RETIRED_ENVIRONMENT_VARIABLES.join(", ")}`,
    );
    expect(() => assertNoRetiredEnvironmentVariables(environment)).toThrow(
      /Settings page or with MCP settings\.set/,
    );
    expect(() => assertNoRetiredEnvironmentVariables(environment)).toThrow(
      /SETUP\.md, section "Removing migrated environment variables"/,
    );
  });

  it("accepts an environment with no retired variables", () => {
    expect(() =>
      assertNoRetiredEnvironmentVariables({ DATABASE_URL: "postgres://example" }),
    ).not.toThrow();
  });
});
