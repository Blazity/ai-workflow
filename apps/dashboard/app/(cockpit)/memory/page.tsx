// apps/dashboard/app/(cockpit)/memory/page.tsx: Agent memory ("/memory")
import { Suspense } from "react";

import { MemoryData } from "@/app/memory-data";
import { MemorySkeleton } from "@/app/memory-skeleton";

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string; doc?: string }>;
}) {
  const sp = await searchParams;
  const subjectKey = typeof sp.subject === "string" ? sp.subject : undefined;
  const docPath = typeof sp.doc === "string" ? sp.doc : undefined;
  // Keyed on the selection: opening a document streams a fresh skeleton
  // instead of blocking the listing that is already on screen.
  return (
    <Suspense key={`${subjectKey ?? ""}:${docPath ?? ""}`} fallback={<MemorySkeleton />}>
      <MemoryData subjectKey={subjectKey} docPath={docPath} />
    </Suspense>
  );
}
