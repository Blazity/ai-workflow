import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type {
  CapacityCampaign,
  CapacityRegistry,
} from "./capacity-registry.js";

type CapacityReleasePayload = {
  version: 1;
  releaseApproved: true;
  campaignIdentity: string;
  campaignId: string;
  ownerToken: string;
  subjectKeys: string[];
  ticketKey: string;
};

type CapacityReleaseMarker = CapacityReleasePayload & {
  checksum: string;
};

export class CapacityReleaseMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityReleaseMarkerError";
  }
}

function checksum(payload: CapacityReleasePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function markerFor(input: {
  campaignIdentity: string;
  campaign: CapacityCampaign;
  ticketKey: string;
}): CapacityReleaseMarker {
  const ticketKey = input.ticketKey.trim().toUpperCase();
  if (!ticketKey) {
    throw new CapacityReleaseMarkerError(
      "Capacity release approval requires an exact ticket key",
    );
  }
  const payload: CapacityReleasePayload = {
    version: 1,
    releaseApproved: true,
    campaignIdentity: input.campaignIdentity,
    campaignId: input.campaign.id,
    ownerToken: input.campaign.ownerToken,
    subjectKeys: [...input.campaign.subjectKeys],
    ticketKey,
  };
  return { ...payload, checksum: checksum(payload) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMarker(source: string): CapacityReleaseMarker {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CapacityReleaseMarkerError(
      "Capacity release approval marker is not valid JSON",
    );
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.releaseApproved !== true ||
    typeof value.campaignIdentity !== "string" ||
    typeof value.campaignId !== "string" ||
    typeof value.ownerToken !== "string" ||
    !Array.isArray(value.subjectKeys) ||
    !value.subjectKeys.every((subject) => typeof subject === "string") ||
    typeof value.ticketKey !== "string" ||
    value.ticketKey.length === 0 ||
    typeof value.checksum !== "string"
  ) {
    throw new CapacityReleaseMarkerError(
      "Capacity release approval marker has an invalid shape",
    );
  }

  const marker = value as CapacityReleaseMarker;
  const { checksum: actualChecksum, ...payload } = marker;
  if (checksum(payload) !== actualChecksum) {
    throw new CapacityReleaseMarkerError(
      "Capacity release approval marker checksum does not match",
    );
  }
  return marker;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertMarkerBinding(
  marker: CapacityReleaseMarker,
  campaignIdentity: string,
  campaign: CapacityCampaign,
): void {
  if (
    marker.campaignIdentity !== campaignIdentity ||
    marker.campaignId !== campaign.id ||
    marker.ownerToken !== campaign.ownerToken ||
    !sameStrings(marker.subjectKeys, campaign.subjectKeys)
  ) {
    throw new CapacityReleaseMarkerError(
      "Capacity release approval marker does not match this campaign",
    );
  }
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Create, but never overwrite, the proof that the test's release barrier
 * completed. A torn write is invalid JSON and therefore fails closed.
 */
export async function writeCapacityReleaseMarker(input: {
  markerPath: string;
  campaignIdentity: string;
  campaign: CapacityCampaign;
  ticketKey: string;
}): Promise<void> {
  const expected = markerFor(input);
  try {
    await writeFile(input.markerPath, `${JSON.stringify(expected)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const existing = parseMarker(await readFile(input.markerPath, "utf8"));
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new CapacityReleaseMarkerError(
      "Capacity release approval marker already exists for different evidence",
    );
  }
}

/**
 * The timeout finalizer only releases exact deterministic campaign subjects.
 * Missing approval is safe only when the test already removed every one of
 * those subjects. Invalid approval and owner/state drift always fail closed.
 */
export async function finalizeCapacityReservations(input: {
  registry: CapacityRegistry;
  markerPath: string;
  campaignIdentity: string;
  campaign: CapacityCampaign;
}): Promise<number> {
  let source: string;
  try {
    source = await readFile(input.markerPath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const remaining = await input.registry.countCampaignSubjects(input.campaign);
    if (remaining === 0) return 0;
    throw new CapacityReleaseMarkerError(
      `Capacity release approval marker is missing while ${remaining} campaign reservation(s) remain`,
    );
  }

  const marker = parseMarker(source);
  assertMarkerBinding(marker, input.campaignIdentity, input.campaign);
  return input.registry.cleanup(input.campaign);
}
