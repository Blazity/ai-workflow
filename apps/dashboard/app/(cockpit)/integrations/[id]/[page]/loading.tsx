// apps/dashboard/app/(cockpit)/integrations/[id]/[page]/loading.tsx
//
// A contributed page fetches from its provider, and that fetch is the one thing
// in this area we have no control over. Without this file the segment has no
// Suspense boundary of its own: the previous screen stays on display while the
// server component waits, so a slow provider reads as a tab click that did not
// land, and the person clicks again.
//
// The tab strip above stays, because the layout is not what suspended and
// swapping it for a skeleton would make the area flicker on every tab change.
// A page is still expected to bound its own fetches; this says "we asked",
// not "this will finish".
export default function ContributedPageLoading() {
  return (
    <div className="flex flex-col gap-3 px-4 lg:px-6 pt-5 pb-8" aria-busy="true">
      <div className="font-mono text-[12px] text-neutral-500">Loading this page...</div>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <div className="h-6 w-[220px] rounded-[3px] bg-neutral-200 animate-ck-pulse" />
        <div className="h-[13px] w-[320px] rounded-[3px] bg-neutral-200 animate-ck-pulse" />
        <div className="mt-2 h-[92px] w-full max-w-[640px] rounded-[4px] border border-neutral-200 bg-panel" />
      </div>
    </div>
  );
}
