"use client";

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
      <button
        type="button"
        onClick={onRefresh}
        disabled={isRefreshing}
        className="appearance-none rounded-[3px] border border-neutral-200 bg-panel px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.04em] text-neutral-900 cursor-pointer disabled:cursor-default disabled:opacity-50"
      >
        {isRefreshing ? "Refreshing…" : "Refresh"}
      </button>
      {error && (
        <span role="status" className="font-mono text-[10px] text-[#7A5A00]">
          {error}
        </span>
      )}
    </div>
  );
}

