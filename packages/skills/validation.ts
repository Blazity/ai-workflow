export type SkillValidationErrorCode =
  | "invalid_manifest"
  | "invalid_artifact"
  | "artifact_drift"
  | "invalid_lock_file";

export class SkillValidationError extends Error {
  constructor(
    public readonly code: SkillValidationErrorCode,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = "SkillValidationError";
  }
}

export type SkillValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SkillValidationError };
