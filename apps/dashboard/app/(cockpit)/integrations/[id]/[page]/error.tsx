"use client";

/**
 * A page an integration contributes threw.
 *
 * This is code we did not write, rendering inside our tree, so it is the one
 * place in the cockpit where a crash is expected rather than exceptional.
 * Without this boundary the whole route segment is replaced by the app's
 * generic error screen and the sidebar goes with it: an admin would see the
 * product break and have no reason to suspect the plugin.
 *
 * So the blame is named, the chrome around it stays, and the two things that
 * help are offered: try it again, in case it was the provider having a moment,
 * and the Connection tab, which is the only part of an integration we can do
 * anything about from here.
 */
export default function ContributedPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 lg:px-6 pt-5 pb-8 max-w-[640px]">
      <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
        This page could not be rendered
      </h2>
      <p className="m-0 font-body text-[13px] text-neutral-600">
        The screen behind this tab comes from the integration itself, and it
        failed while drawing. Everything else in the cockpit is unaffected: the
        rest of this integration, its blocks and any run using it are not
        touched by what happens on this tab.
      </p>
      {error.digest && (
        <p className="m-0 font-mono text-[11px] text-neutral-500">
          Reference {error.digest}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-[30px] items-center rounded-[3px] border border-neutral-300 bg-panel px-3 font-mono text-[11px] font-medium tracking-[0.04em] text-neutral-800 appearance-none cursor-pointer transition-colors duration-[var(--motion-fast)] hover:bg-app-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1"
        >
          Try again
        </button>
        <a
          href="/integrations"
          className="font-mono text-[11px] font-medium tracking-[0.04em] text-mariner no-underline hover:underline"
        >
          Back to Integrations -&gt;
        </a>
      </div>
    </div>
  );
}
