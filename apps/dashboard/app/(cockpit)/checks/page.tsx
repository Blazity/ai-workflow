import { Suspense } from "react";

import { ChecksData } from "@/app/checks-data";

export default function ChecksPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">Loading pre-PR checks…</div>
      }
    >
      <ChecksData />
    </Suspense>
  );
}
