// apps/dashboard/app/prompts-skeleton.tsx
import { Block } from "./skeleton-block";

export function PromptsSkeleton() {
  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <Block className="h-10 w-56" />
        <Block className="h-9 w-64" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {Array.from({ length: 2 }, (_, i) => (
          <Block key={i} className="h-[124px]" />
        ))}
      </div>
      <div className="flex flex-col lg:grid lg:grid-cols-[340px_1fr] gap-3 lg:min-h-[720px]">
        <Block className="lg:h-full h-[300px]" />
        <Block className="lg:h-full h-[400px]" />
      </div>
    </div>
  );
}
