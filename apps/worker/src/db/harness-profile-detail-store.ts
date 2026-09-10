import type { Db } from "./client.js";
import { listHarnessProfileUsage } from "./harness-profile-usage-store.js";
import {
  deleteHarnessProfile,
  getHarnessProfileDetail,
} from "../harness-profiles/store.js";

export async function getHarnessProfileDetailWithUsage(
  db: Db,
  input: Omit<Parameters<typeof getHarnessProfileDetail>[1], "usage">,
) {
  return getHarnessProfileDetail(db, {
    ...input,
    usage: await listHarnessProfileUsage(db, input.profileId),
  });
}

export async function deleteHarnessProfileWithUsage(
  db: Db,
  input: Omit<Parameters<typeof deleteHarnessProfile>[1], "usage">,
) {
  return deleteHarnessProfile(db, {
    ...input,
    usage: await listHarnessProfileUsage(db, input.profileId),
  });
}
