// apps/dashboard/app/cost-skeleton.tsx
import { Block } from "./skeleton-block";

export function CostSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }, (_, i) => <Block key={i} className="h-[100px]" />)}
      </div>
      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-3">
        <Block className="h-[260px]" />
        <Block className="h-[260px]" />
      </div>
      <Block className="h-[300px]" />
      <Block className="h-[300px]" />
    </div>
  );
}
