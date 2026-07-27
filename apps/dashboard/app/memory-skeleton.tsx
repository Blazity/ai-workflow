import { Block } from "./skeleton-block";

export function MemorySkeleton() {
  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      <Block className="h-10 w-64" />
      <Block className="h-[420px]" />
    </div>
  );
}
