import {
  SkillValidationError,
  type SkillValidationErrorCode,
} from "./validation";

export class HarnessSkillArtifactIntegrityError extends SkillValidationError {
  constructor(
    reason: string,
    code: SkillValidationErrorCode = "invalid_artifact",
  ) {
    super(code, reason);
    this.name = "HarnessSkillArtifactIntegrityError";
  }
}
