import { Suspense } from "react";

import { EditorData } from "@/app/editor-data";

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">Loading workflow…</div>
      }
    >
      <EditorData />
    </Suspense>
  );
}
