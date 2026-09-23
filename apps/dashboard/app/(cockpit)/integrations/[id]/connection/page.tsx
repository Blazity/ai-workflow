// apps/dashboard/app/(cockpit)/integrations/[id]/connection/page.tsx
// One integration's connection ("/integrations/<id>/connection"). S7 wraps this
// route in the integration's own area layout, where it becomes the Connection
// tab beside the pages the integration contributes.
import { Suspense } from "react";

import { ConnectionData } from "./connection-data";

export default async function IntegrationConnectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">
          Loading connection...
        </div>
      }
    >
      <ConnectionData id={id} />
    </Suspense>
  );
}
