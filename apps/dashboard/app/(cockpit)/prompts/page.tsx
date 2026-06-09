// apps/dashboard/app/(cockpit)/prompts/page.tsx — Prompts ("/prompts")
import { Suspense } from "react";

import { PromptsData } from "@/app/prompts-data";
import { PromptsSkeleton } from "@/app/prompts-skeleton";

export default function PromptsPage() {
  return (
    <Suspense fallback={<PromptsSkeleton />}>
      <PromptsData />
    </Suspense>
  );
}
