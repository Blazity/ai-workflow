import { Block } from "./skeleton-block";

export function HealthSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pb-10 pt-5 lg:px-6 lg:pt-6">
      <div className="mb-5 flex items-end justify-between border-b border-neutral-300 pb-5">
        <div className="space-y-2">
          <Block className="h-3 w-36" />
          <Block className="h-8 w-52" />
          <Block className="h-4 w-[480px] max-w-full" />
        </div>
        <Block className="h-8 w-24" />
      </div>
      <Block className="mb-5 h-[92px]" />
      <div className="grid gap-4">
        <Block className="h-[330px]" />
        <Block className="h-[220px]" />
      </div>
    </div>
  );
}
