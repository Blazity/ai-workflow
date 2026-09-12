import { z } from "zod";
import {
  REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH,
  REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE,
  REPOSITORY_SCRIPT_GROUP_NAME_PATTERN,
} from "./repository-scripts";

/**
 * One repository script group name, as a runtime schema.
 *
 * Group names are user-facing identifiers (a group's own key, an `extends`
 * entry, a `gateGroups` entry, a block's group picker), so they get the shape of
 * any other short slug: lowercase, digits, hyphens, capped so it stays readable
 * in a dropdown.
 *
 * Every zod parse of a group name goes through THIS object rather than a copy of
 * the rule: the workflow definition rules that validate a node's selected groups
 * (`engine/definition/block-params-schemas.ts`) and the checks engine's own
 * stored config (`engine/pre-pr-checks/config.ts`). A name accepted on one side
 * and refused on the other would be a profile that saves and then fails to
 * resolve at run time. It is built from the same constants the repository script
 * contracts declare (which is also what the dashboard's client-side
 * `isRepositoryScriptGroupName` reads), so a group name a definition may name is
 * exactly a group name a repository may declare.
 *
 * The `run_checks` and `run_scripts` manifests restate the same schema instead
 * of importing it: the catalog generator parses a manifest and allows runtime
 * values from zod only.
 */
export const repositoryScriptGroupNameSchema = z
  .string()
  .max(
    REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH,
    `group name must be at most ${REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH} characters`,
  )
  .regex(REPOSITORY_SCRIPT_GROUP_NAME_PATTERN, REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE);
