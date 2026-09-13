import assert from "node:assert/strict";
import test from "node:test";

import {
  REPOSITORY_RULES_VARIABLE_NAMES,
  repositoryRulesVariablesError,
  unknownRepositoryRulesVariables,
} from "./prompt-variables";

test("repository rules expose exactly the five run-start variables", () => {
  assert.deepEqual(REPOSITORY_RULES_VARIABLE_NAMES, [
    "ticket_key",
    "ticket_url",
    "branch_name",
    "repo_path",
    "repo_default_branch",
  ]);
});

test("repository rules unknown-variable errors are stable and actionable", () => {
  const rules =
    "Use {{ repo_path }}, not {{ticket_description}} or {{ticket_description}} and {{typo}}.";
  assert.deepEqual(unknownRepositoryRulesVariables(rules), [
    "ticket_description",
    "typo",
  ]);
  assert.equal(
    repositoryRulesVariablesError(rules),
    "Unknown repository rules variables: {{ticket_description}}, {{typo}}. Allowed variables: ticket_key, ticket_url, branch_name, repo_path, repo_default_branch.",
  );
  assert.equal(repositoryRulesVariablesError("Build {{repo_default_branch}}."), null);
});
