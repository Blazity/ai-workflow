import { Suspense } from "react";

import { ScriptsData } from "@/app/scripts-data";

export default function ScriptsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">
          Loading repository scripts…
        </div>
      }
    >
      <ScriptsData />
    </Suspense>
  );
}
