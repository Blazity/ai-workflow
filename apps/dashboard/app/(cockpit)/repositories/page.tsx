// apps/dashboard/app/(cockpit)/repositories/page.tsx: Repositories ("/repositories")
import { Suspense } from "react";

import { RepositoriesData } from "./repositories-data";

export default function RepositoriesPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">
          Loading repositories...
        </div>
      }
    >
      <RepositoriesData />
    </Suspense>
  );
}
