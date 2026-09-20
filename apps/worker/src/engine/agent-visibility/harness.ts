/**
 * What the harness put around a prompt, as the record keeps it.
 *
 * Only what this send really had. A send on the legacy, unpinned path has no
 * profile and no pinned skills, and saying otherwise would put a profile's
 * settings on a record that never obeyed them. The wrapper script is not here:
 * the step already holds it as an argument and hands it to the record itself.
 */
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import type { AgentBriefingCapture } from "./plan.js";

const SHA256 = /^[0-9a-f]{64}$/;

export function briefingHarness(input: {
  /** The provider the run asked for, used when nothing is pinned. */
  kind: string;
  model: string;
  runtime?: ResolvedHarnessRuntime | undefined;
  /** The JSON output schema the wrapper sends, where one goes. */
  schema?: string | undefined;
}): AgentBriefingCapture["harness"] {
  const manifest = input.runtime?.manifest;
  const skills = (manifest?.skills ?? []).flatMap((skill) => {
    const sha256 = skill.artifactHash.toLowerCase();
    // A skill names its version, its hash, or both. This path pins by hash
    // only, so a hash the record cannot spell leaves the skill out rather than
    // taking the whole briefing down with it.
    return SHA256.test(sha256) ? [{ id: skill.name, sha256 }] : [];
  });
  return {
    provider: manifest?.harness.provider ?? input.kind,
    model: input.model,
    ...(input.schema === undefined ? {} : { outputSchema: input.schema }),
    profile: manifest ? { id: manifest.profileId, version: manifest.version } : null,
    ...(skills.length > 0 ? { skills } : {}),
  };
}
