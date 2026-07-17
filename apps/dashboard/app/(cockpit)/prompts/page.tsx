// apps/dashboard/app/(cockpit)/prompts/page.tsx — Prompt library ("/prompts")
import { Suspense } from "react";

import { PromptLibraryData } from "@/app/prompt-library-data";
import { PromptLibrarySkeleton } from "@/app/prompt-library-skeleton";

export default function PromptsPage() {
  return (
    <Suspense fallback={<PromptLibrarySkeleton />}>
      <PromptLibraryData />
    </Suspense>
  );
}
