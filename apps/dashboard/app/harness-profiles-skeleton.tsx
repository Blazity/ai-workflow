import { Block } from "./skeleton-block";

export function HarnessProfilesSkeleton() {
  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <Block className="h-10 w-64" />
        <Block className="h-9 w-32" />
      </div>
      <div className="flex flex-col lg:grid lg:grid-cols-[300px_1fr] gap-3 lg:min-h-[720px]">
        <Block className="lg:h-full h-[300px]" />
        <Block className="lg:h-full h-[520px]" />
      </div>
    </div>
  );
}
