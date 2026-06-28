import { Suspense } from "react";

import { UsersData } from "@/app/users-data";
import { UsersSkeleton } from "@/app/users-skeleton";

export default function UsersPage() {
  return (
    <Suspense fallback={<UsersSkeleton />}>
      <UsersData />
    </Suspense>
  );
}
