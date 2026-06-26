import { redirect } from "next/navigation";

import { getJSON } from "@/lib/api/server";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/errors";
import {
  NotAuthorizedScreen,
  UsersScreen,
  type DashboardInviteRow,
  type DashboardUserRow,
} from "@/components/cockpit/screens/users";

type UsersResponse = { users: DashboardUserRow[] };
type InvitesResponse = { invites: DashboardInviteRow[] };

export async function UsersData() {
  try {
    const [users, invites] = await Promise.all([
      getJSON<UsersResponse>("/api/v1/users"),
      getJSON<InvitesResponse>("/api/v1/invites"),
    ]);
    return <UsersScreen initialUsers={users.users} initialInvites={invites.invites} />;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    if (error instanceof ForbiddenError) {
      return <NotAuthorizedScreen />;
    }
    throw error;
  }
}
