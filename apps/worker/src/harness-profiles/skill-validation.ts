import type { HarnessSkillArtifactHashInput } from "@shared/skills";
import {
  HarnessSkillArtifactIntegrityError,
  verifyHarnessSkillArtifact as verifySharedSkillArtifact,
} from "@shared/skills";
import { sha256Digest } from "./skill-artifact-digest.js";

export { HarnessSkillArtifactIntegrityError };

export function verifyHarnessSkillArtifact(
  artifact: HarnessSkillArtifactHashInput & { artifactHash: string },
): void {
  verifySharedSkillArtifact(artifact, sha256Digest);
}
