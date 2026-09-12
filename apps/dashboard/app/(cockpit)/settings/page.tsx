// apps/dashboard/app/(cockpit)/settings/page.tsx: Deployment settings ("/settings")
import { Suspense } from "react";

import { SettingsData } from "./settings-data";

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">
          Loading settings...
        </div>
      }
    >
      <SettingsData />
    </Suspense>
  );
}
