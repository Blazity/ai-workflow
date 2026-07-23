/**
 * Profile selection and pinned runtime resolution stay available to v2
 * workflows. The standalone authoring surface is enabled only after the
 * preview canary has exercised both providers and one imported skill.
 */
export function isHarnessProfileAuthoringEnabled(
  value = process.env.NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED,
): boolean {
  return value === "1";
}

export const harnessProfileAuthoringEnabled =
  isHarnessProfileAuthoringEnabled();
