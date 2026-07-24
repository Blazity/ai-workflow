import type { HarnessProfileDto } from "@shared/contracts";

export function resolveProfileSelection(
  profiles: HarnessProfileDto[],
  requestedProfileId: string | null,
): string | null {
  if (
    requestedProfileId &&
    profiles.some((profile) => profile.id === requestedProfileId)
  ) {
    return requestedProfileId;
  }

  return (
    profiles.find((profile) => profile.archivedAt === null)?.id ??
    profiles[0]?.id ??
    null
  );
}

export function profileSelectionHref(
  pathname: string,
  search: string,
  profileId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (profileId) {
    params.set("profile", profileId);
  } else {
    params.delete("profile");
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
