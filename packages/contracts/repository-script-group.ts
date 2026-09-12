import { z } from "zod";
import {
  REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH,
  REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE,
  REPOSITORY_SCRIPT_GROUP_NAME_PATTERN,
} from "./repository-scripts";

/**
 * One repository script group name, as a runtime schema, for the workflow
 * definition rules that validate a node's selected groups. It is built from the
 * same constants the repository script contracts declare, so a group name a
 * definition may name is exactly a group name a repository may declare.
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
