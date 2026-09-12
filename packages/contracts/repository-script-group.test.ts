import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH,
  REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE,
  repositoryScriptGroupNameSchema,
} from "./index.js";

/**
 * The one schema every group-name check goes through: the checks engine config
 * (`engine/pre-pr-checks/config.ts`), the block params schemas, and the
 * dashboard all parse against this object rather than a copy of the rule. A
 * name accepted on one side and refused on another would be a profile that
 * saves and then fails to resolve at run time.
 */
describe("repositoryScriptGroupNameSchema", () => {
  it("accepts a lowercase slug with digits and hyphens", () => {
    for (const name of ["lint", "a", "build-2", "e2e-smoke-3"]) {
      expect(repositoryScriptGroupNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("refuses a name that does not start with a lowercase letter", () => {
    for (const name of ["", "2fast", "-lead", "Lint", "lint_test", "lint test"]) {
      const result = repositoryScriptGroupNameSchema.safeParse(name);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE,
      );
    }
  });

  it("caps the name at the shared maximum length", () => {
    const atMax = "a".repeat(REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH);
    expect(repositoryScriptGroupNameSchema.safeParse(atMax).success).toBe(true);
    expect(
      repositoryScriptGroupNameSchema.safeParse(`${atMax}a`).success,
    ).toBe(false);
  });
});
