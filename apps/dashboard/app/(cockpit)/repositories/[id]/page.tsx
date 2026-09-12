// apps/dashboard/app/(cockpit)/repositories/[id]/page.tsx: one repository ("/repositories/12")
import { Suspense } from "react";
import { notFound } from "next/navigation";

import { RepositoryData } from "./repository-data";

export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Digits only: the worker refuses anything else, and a route segment that is
  // not an id is a bad link rather than a request worth sending.
  if (!/^[0-9]{1,12}$/.test(id)) notFound();
  return (
    <Suspense
      key={id}
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">
          Loading repository...
        </div>
      }
    >
      <RepositoryData id={Number(id)} />
    </Suspense>
  );
}
