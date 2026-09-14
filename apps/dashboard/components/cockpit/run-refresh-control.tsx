"use client";

import { Button } from "@/components/ui/button";

export function RunRefreshControl({
  isRefreshing,
  error,
  onRefresh,
}: {
  isRefreshing: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button
        type="button"
        variant="text"
        onClick={onRefresh}
        disabled={isRefreshing}
        className="rounded-[3px] border border-neutral-200 bg-panel px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.04em] text-neutral-900 cursor-pointer disabled:cursor-default disabled:opacity-50"
      >
        {isRefreshing ? "Refreshing…" : "Refresh"}
      </Button>
      {error && (
        <span role="status" className="font-mono text-[10px] text-[#7A5A00]">
          {error}
        </span>
      )}
    </div>
  );
}
