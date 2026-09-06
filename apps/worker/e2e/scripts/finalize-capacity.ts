import {
  createCapacityCampaignFromIdentity,
  createE2ECapacityRegistry,
} from "../helpers/capacity-registry.js";
import { finalizeCapacityReservations } from "../helpers/capacity-release.js";
import { e2eEnv } from "../env.js";

const campaignIdentity = e2eEnv.E2E_CAPACITY_CAMPAIGN_ID;
const markerPath = e2eEnv.E2E_CAPACITY_RELEASE_MARKER;
if (!campaignIdentity || !markerPath) {
  throw new Error(
    "Capacity finalizer requires the trusted campaign identity and release marker path",
  );
}

const campaign = createCapacityCampaignFromIdentity(
  e2eEnv.MAX_CONCURRENT_AGENTS,
  campaignIdentity,
);
const released = await finalizeCapacityReservations({
  registry: createE2ECapacityRegistry(),
  markerPath,
  campaignIdentity,
  campaign,
});

console.log(
  `[capacity-finalizer] released ${released} exact reservation(s) for ${campaign.id}`,
);
