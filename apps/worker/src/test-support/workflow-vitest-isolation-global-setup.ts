import {
  cleanupWorkflowVitestIsolation,
  readWorkflowVitestIsolationFromEnvironment,
} from "./workflow-vitest-isolation.js";

export function setup(): () => Promise<void> {
  const isolation = readWorkflowVitestIsolationFromEnvironment();
  return () => cleanupWorkflowVitestIsolation(isolation);
}
