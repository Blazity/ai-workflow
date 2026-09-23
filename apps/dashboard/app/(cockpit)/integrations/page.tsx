// apps/dashboard/app/(cockpit)/integrations/page.tsx: Integrations ("/integrations")
import { Suspense } from "react";

import { IntegrationsData } from "./integrations-data";

export default function IntegrationsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">
          Loading integrations...
        </div>
      }
    >
      <IntegrationsData />
    </Suspense>
  );
}
