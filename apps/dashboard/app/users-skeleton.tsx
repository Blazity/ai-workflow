import { Block } from "./skeleton-block";

export function UsersSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-5 lg:px-6">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-2">
          <Block className="h-3 w-20" />
          <Block className="h-8 w-32" />
        </div>
        <Block className="h-9 w-28" />
      </div>
      <Block className="h-10 w-64" />
      <Block className="h-[360px] w-full" />
    </div>
  );
}
