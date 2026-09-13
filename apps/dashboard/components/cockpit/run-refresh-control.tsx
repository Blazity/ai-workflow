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
        onClick={onRefresh}
        disabled={isRefreshing}
        variant="secondary"
        size="sm"
      >
        {isRefreshing ? "Refreshing…" : "Refresh"}
      </Button>
      {error && (
        <span role="status" className="font-mono text-[10px] text-neutral-800">
          {error}
        </span>
      )}
    </div>
  );
}
