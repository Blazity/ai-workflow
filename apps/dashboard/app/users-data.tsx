import { redirect } from "next/navigation";

import { getJSON } from "@/lib/api/server";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";
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
    const [session, users, invites] = await Promise.all([
      requireSession(),
      getJSON<UsersResponse>("/api/v1/users"),
      getJSON<InvitesResponse>("/api/v1/invites"),
    ]);
    return (
      <UsersScreen
        initialInvites={invites.invites}
        initialUsers={users.users}
        workspaceName={session.organizationName}
      />
    );
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
