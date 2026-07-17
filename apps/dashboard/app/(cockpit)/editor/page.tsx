import { Suspense } from "react";

import { EditorData } from "@/app/editor-data";

export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ definition?: string; node?: string }>;
}) {
  const { definition, node } = await searchParams;
  const definitionId = definition !== undefined && /^\d+$/.test(definition) ? Number(definition) : undefined;
  return (
    <Suspense
      fallback={
        <div className="p-6 font-mono text-[12px] text-neutral-500">Loading workflow…</div>
      }
    >
      <EditorData definitionId={definitionId} nodeId={node} />
    </Suspense>
  );
}
