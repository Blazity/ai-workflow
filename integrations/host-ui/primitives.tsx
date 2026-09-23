import type { ReactNode } from "react";

/**
 * The primitives a contributed page is built from.
 *
 * They are presentational and nothing else: no state, no effects, no controls
 * that submit, no overlay, no navigation into the product. A page composes
 * them with its own elements and Tailwind classes, which the dashboard's
 * stylesheet compiles because it scans `integrations/` (see `globals.css`).
 *
 * Every value below is a token from `DESIGN.md`: an integration page picks up a
 * palette change in the cockpit the same day the cockpit does. What this file
 * does NOT accept is a `className`: the look of a primitive is the product's,
 * and a page that needs different spacing wraps it rather than redresses it.
 *
 * None of these are client components. A page that needs a handler marks its
 * own file `"use client"`.
 */

export type HostTone = "neutral" | "success" | "warning" | "failed";

// Two raw values, both already on screen elsewhere in the cockpit: the failure
// band's border (`#F0B8AE`) and the warning band's text (`#A23E18`). They are
// the drift DESIGN.md records under "Literal colours still in globals.css", and
// matching them is the point: a band in an integration's page and a band on the
// Integrations screen have to be the same band. `primitives.test.ts` pins this
// pair, so a third raw colour is a failing test rather than a quiet divergence.
const CHIP_TONES: Record<HostTone, string> = {
  neutral: "border-neutral-300 bg-app-bg text-neutral-700",
  success: "border-sulu-300 bg-success-bg text-success-fg",
  warning: "border-orange-300 bg-orange-100 text-[#A23E18]",
  failed: "border-[#F0B8AE] bg-fail-bg text-fail-fg",
};

const NOTICE_TONES: Record<HostTone, string> = {
  neutral: "border-neutral-200 bg-app-bg text-neutral-700",
  success: "border-sulu-300 bg-success-bg text-success-fg",
  warning: "border-orange-300 bg-orange-100 text-[#A23E18]",
  failed: "border-[#F0B8AE] bg-fail-bg text-fail-fg",
};

/**
 * The page itself: the cockpit's own gutters, heading block and rhythm, so a
 * contributed page lines up with the screens next to it down to the pixel.
 */
export function Page({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] tracking-[-0.02em] text-neutral-900">
          {title}
        </h2>
        {description ? (
          <p className="m-0 font-body text-[13px] text-neutral-600">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** A titled block inside a page. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 font-display text-base font-medium leading-[1.3] text-neutral-900">
          {title}
        </h3>
        {description ? (
          <p className="m-0 font-body text-[12px] text-neutral-600">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A bordered panel. The default surface for anything that is one thing. */
export function Card({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      {title ? (
        <div className="mb-2 font-display text-base font-medium leading-[1.3] text-neutral-900">
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export interface KeyValueItem {
  readonly label: string;
  readonly value: ReactNode;
}

/**
 * Label and value rows. Values are mono, because what a provider returns is an
 * id, a ref, a count or a timestamp far more often than it is prose.
 */
export function KeyValue({ items }: { items: readonly KeyValueItem[] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="m-0 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500 self-center">
            {item.label}
          </dt>
          <dd className="m-0 font-mono text-[11px] leading-[1.6] text-neutral-900 break-words">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A status word. Reads what it says; it never decides what it says. */
export function Chip({ tone = "neutral", children }: { tone?: HostTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-pill border px-2 py-[2px] font-mono text-[10px] font-medium tracking-[0.04em] ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A band the reader is meant to act on, or at least to notice. */
export function Notice({ tone = "neutral", children }: { tone?: HostTone; children: ReactNode }) {
  return (
    <div
      role={tone === "failed" ? "alert" : "status"}
      className={`rounded-[3px] border px-3 py-2 font-body text-[12px] ${NOTICE_TONES[tone]}`}
    >
      {children}
    </div>
  );
}

/** Nothing to show, said in the cockpit's own words rather than as blankness. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[3px] border border-dashed border-neutral-300 px-4 py-8 text-center">
      <p className="m-0 mx-auto max-w-[52ch] font-body text-[13px] text-neutral-600">
        {children}
      </p>
    </div>
  );
}

/**
 * A link out of the product, to the provider. Always a new tab and always
 * `noreferrer noopener`, so an integration cannot navigate the cockpit away
 * from under the person using it or hand the destination our window.
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-[11px] font-medium tracking-[0.04em] text-mariner no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1"
    >
      {children}
    </a>
  );
}

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  /** Comparable numbers line up on the right; everything else on the left. */
  readonly align?: "start" | "end";
}

export interface TableRow {
  readonly key: string;
  readonly cells: Readonly<Record<string, ReactNode>>;
}

/** Rows of provider data. Scrolls sideways on a phone rather than reflowing. */
export function Table({
  columns,
  rows,
  empty = "Nothing to show yet.",
}: {
  columns: readonly TableColumn[];
  rows: readonly TableRow[];
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-[4px] border border-neutral-200 bg-panel">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-neutral-100">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`border-b border-neutral-200 px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-neutral-500 ${
                  column.align === "end" ? "text-right" : "text-left"
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-neutral-200 last:border-b-0">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-3 py-2 font-body text-[12px] text-neutral-800 ${
                    column.align === "end" ? "text-right font-mono" : "text-left"
                  }`}
                >
                  {row.cells[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
