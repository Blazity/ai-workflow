// THIS FILE IS GENERATED. DO NOT EDIT.
// Run pnpm run gen:integrations to update.

/**
 * The worker entry of every integration this build ships: provider SDKs,
 * Node modules and secrets. Server only. Nothing that reaches a browser or
 * the Workflow DevKit flow bundle may import this file or the module that
 * re-exports it.
 */
import type { ErasedIntegrationRuntime } from "@integrations/sdk";
import { runtime as arthur } from "../arthur/worker";
import { runtime as github } from "../github/worker";
import { runtime as gitlab } from "../gitlab/worker";
import { runtime as jira } from "../jira/worker";
import { runtime as mem0 } from "../mem0/worker";
import { runtime as slack } from "../slack/worker";

export const generatedIntegrationRuntimes: readonly ErasedIntegrationRuntime[] = [
  arthur,
  github,
  gitlab,
  jira,
  mem0,
  slack,
];
