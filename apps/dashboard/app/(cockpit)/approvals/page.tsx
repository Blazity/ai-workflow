import { Suspense } from "react";

import { ApprovalsData } from "@/app/approvals-data";
import { ApprovalsSkeleton } from "@/app/approvals-skeleton";

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<ApprovalsSkeleton />}>
      <ApprovalsData />
    </Suspense>
  );
}
