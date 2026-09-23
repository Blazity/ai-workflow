"use client";

/**
 * One section of a briefing, read the way the agent read it: its text, cut
 * into the parts it was composed from, each part attributed in a margin to
 * where it came from ("prompt blame"). Our own rules carry the Mariner edge;
 * everything else is the run's or a person's.
 *
 * The text is loaded a page (about 48 KB) at a time, never all of a 512 KB
 * section for the first screen. The part and redaction lists are small and are
 * loaded whole, so what the agent did not get is known before the text is.
 */
import React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";

import { Button, CkChip } from "@/components/ui";
import type { ChipTone } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import {
  readPartsPage,
  readSectionPage,
  readSpansPage,
  type ListPageRead,
} from "@/lib/agent-visibility/contract";
import { checkStoredText } from "@/lib/agent-visibility/copy-check";
import { formatBytes, plural, shortDigest } from "@/lib/agent-visibility/format";
import { loadVisibility } from "@/lib/agent-visibility/load";
import { pageEndByte, readSection, type PartReading, type TextPiece } from "@/lib/agent-visibility/section-text";
import {
  isOurs,
  originLabel,
  partFates,
  redactionLabel,
  sectionKindLabel,
  withheldKeyLabel,
  type PartFate,
} from "@/lib/agent-visibility/wording";
import type {
  AgentBriefingPart,
  AgentBriefingRedactionSpan,
  AgentBriefingSectionHeader,
  AgentBriefingSectionPage,
} from "@shared/agent-visibility";

import { LoadFailureNotice, Loading, Notice } from "./notices";
import { usePagedSequence } from "./paged";

/** Ask the open section to bring one of its parts into view. `nonce` makes
 *  the same request twice count twice. */
export interface PartReveal {
  sectionIndex: number;
  partId: string;
  nonce: number;
}

const FATE_TONES: Record<PartFate["tone"], ChipTone> = {
  lost: "failed",
  deliberate: "mariner",
  kept: "neutral",
  empty: "blocked",
};

function Pieces({ pieces }: { pieces: readonly TextPiece[] }) {
  return (
    <>
      {pieces.map((piece, position) => {
        if (piece.kind === "text") return <React.Fragment key={position}>{piece.text}</React.Fragment>;
        if (piece.kind === "redacted") {
          return (
            <mark
              key={position}
              title={`Redacted: ${redactionLabel(piece.redaction)}`}
              data-redaction={piece.redaction}
              className="rounded-[2px] bg-yellow-700/20 text-yellow-300"
            >
              {piece.text}
            </mark>
          );
        }
        return (
          <span
            key={position}
            role="img"
            aria-label={`Text removed here: ${redactionLabel(piece.redaction)}`}
            title={`Text removed here: ${redactionLabel(piece.redaction)}`}
            className="mx-px inline-block h-[0.9em] w-[3px] translate-y-[1px] rounded-[1px] bg-yellow-500"
          />
        );
      })}
    </>
  );
}

function FateChips({ fates }: { fates: readonly PartFate[] }) {
  if (fates.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {fates.map((fate) => (
        <CkChip key={fate.label} tone={FATE_TONES[fate.tone]}>
          {fate.label}
        </CkChip>
      ))}
    </span>
  );
}

/** One part in the margin-and-text layout of the inspection panel. */
function PartRow({ reading, focused }: { reading: PartReading; focused: boolean }) {
  const { part } = reading;
  const ours = isOurs(part.origin);
  const origin = originLabel(part.origin);
  const fates = partFates(part);
  return (
    <div
      data-part-id={part.id}
      data-origin={ours ? "ours" : part.origin.kind}
      className={`grid grid-cols-1 border-t border-neutral-800 first:border-t-0 @xl:grid-cols-[184px_minmax(0,1fr)] ${
        focused ? "bg-mariner-700/15" : ""
      }`}
    >
      <div
        className={`flex min-w-0 flex-col gap-1 border-l-2 px-3 py-2 @xl:border-r @xl:border-r-neutral-800 ${
          ours ? "border-l-mariner-500 bg-mariner-700/10" : "border-l-transparent"
        }`}
      >
        <span
          className={`font-mono text-[9px] font-medium uppercase tracking-[0.06em] ${
            ours ? "text-mariner-300" : "text-neutral-500"
          }`}
        >
          {origin.kind}
        </span>
        {origin.detail ? (
          <span className="break-words font-mono text-[11px] leading-[1.4] text-neutral-200">{origin.detail}</span>
        ) : null}
        <span className="break-words font-body text-[11px] leading-[1.4] text-neutral-400">{part.title}</span>
        <span className="font-mono text-[10px] text-neutral-500">
          {part.sentBytes > 0 ? `${formatBytes(part.sentBytes)} sent` : "nothing sent"}
        </span>
        <FateChips fates={fates} />
      </div>
      <div className="min-w-0 px-3 py-2">
        {reading.pieces.length > 0 ? (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6] text-neutral-200 [overflow-wrap:anywhere]">
            <Pieces pieces={reading.pieces} />
          </pre>
        ) : null}
        {fates.length > 0 ? (
          <ul className={`m-0 flex list-none flex-col gap-1 p-0 font-body text-[12px] leading-[1.5] text-neutral-300 ${reading.pieces.length > 0 ? "mt-2" : ""}`}>
            {fates.map((fate) => (
              <li key={fate.label}>
                <span className="font-semibold text-neutral-100">{fate.label}.</span> {fate.sentence}
              </li>
            ))}
          </ul>
        ) : null}
        {part.controlCharactersStripped ? (
          <p className="m-0 mt-1 font-body text-[12px] text-neutral-400">
            {plural(part.controlCharactersStripped, "control character")} stripped from the stored copy.
          </p>
        ) : null}
        {reading.loaded === "some" ? (
          <p className="m-0 mt-1 font-mono text-[10px] text-neutral-500">Continues past the loaded text.</p>
        ) : null}
      </div>
    </div>
  );
}

type Copy =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; text: string; digestChecked: boolean }
  | { state: "copied"; digestChecked: boolean }
  | { state: "failed"; message: string };

/**
 * Copy the section exactly as stored. The whole text is loaded and checked
 * first, and only then offered: Safari drops the click's permission to write
 * the clipboard across the awaited requests, so the copy itself is a second,
 * immediate click.
 */
function SectionCopy({
  header,
  text,
}: {
  header: AgentBriefingSectionHeader;
  text: { done: boolean; pages: readonly AgentBriefingSectionPage[]; loadAll: () => Promise<readonly AgentBriefingSectionPage[]> };
}) {
  const [copy, setCopy] = React.useState<Copy>({ state: "idle" });
  const trimmed = header.truncatedForStorage;
  const what = trimmed
    ? `Copy what we kept (${formatBytes(header.storedBytes)} of ${formatBytes(header.redactedBytes)})`
    : `Copy section (${formatBytes(header.storedBytes)})`;

  const prepare = async (pages: readonly AgentBriefingSectionPage[]) => {
    const check = await checkStoredText(pages, header);
    setCopy(check.ok ? { state: "ready", text: check.text, digestChecked: check.digestChecked } : { state: "failed", message: check.message });
  };

  React.useEffect(() => {
    if (text.done && copy.state === "idle") void prepare(text.pages);
    // Prepared once, when the last page arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text.done]);

  if (copy.state === "ready" || copy.state === "copied") {
    const ready = copy.state === "ready" ? copy : null;
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (!ready) return;
            navigator.clipboard
              .writeText(ready.text)
              .then(() => setCopy({ state: "copied", digestChecked: ready.digestChecked }))
              .catch((error: unknown) =>
                setCopy({
                  state: "failed",
                  message: `The browser refused to write the clipboard: ${error instanceof Error ? error.message : String(error)}`,
                }),
              );
          }}
          disabled={!ready}
        >
          {copy.state === "copied" ? "Copied" : what}
        </Button>
        <span className="font-body text-[12px] text-neutral-600">
          {copy.state === "copied"
            ? copy.digestChecked
              ? "Exactly the stored bytes: the length and the sha256 matched."
              : "The length matched; this browser cannot check the sha256 here."
            : "Checked against what the worker stored. One click puts it on the clipboard."}
        </span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        loading={copy.state === "loading"}
        onClick={() => {
          if (text.done) {
            void prepare(text.pages);
            return;
          }
          setCopy({ state: "loading" });
          void text.loadAll().then((pages) => {
            const last = pages.at(-1);
            if (!last || last.nextOffset !== null) {
              setCopy({ state: "failed", message: "The rest of the section could not be loaded, so nothing was copied." });
              return;
            }
            void prepare(pages);
          });
        }}
      >
        Prepare the whole section to copy
      </Button>
      {copy.state === "failed" ? (
        <span role="alert" className="font-body text-[12px] text-fail-fg">
          {copy.message}
        </span>
      ) : (
        // Two steps, and the first one says so: the bytes are loaded and
        // checked before anything reaches the clipboard, so nobody in a hurry
        // pastes whatever was on it before.
        <span className="font-body text-[12px] text-neutral-600">
          Step 1 of 2: the text is loaded and checked, then one click copies it.
        </span>
      )}
    </span>
  );
}

function listItems<T>(pages: readonly ListPageRead<T>[]): T[] {
  return pages.flatMap((page) => page.items);
}

function unreadableCount(pages: readonly ListPageRead<unknown>[]): number {
  return pages.reduce((total, page) => total + page.unreadable.length, 0);
}

/** The parts the agent did not get, or that we did not keep, from the whole
 *  part list: known before any text is loaded. */
function Omissions({
  parts,
  onShow,
}: {
  parts: readonly AgentBriefingPart[];
  onShow: (partId: string) => void;
}) {
  const withFates = parts
    .map((part) => ({ part, fates: partFates(part) }))
    .filter((entry) => entry.fates.some((fate) => fate.tone !== "empty"));
  const notGiven = withFates.filter((entry) => entry.fates.some((fate) => fate.tone === "lost" || fate.tone === "deliberate"));
  const notKept = withFates.filter((entry) => entry.fates.some((fate) => fate.tone === "kept"));
  if (notGiven.length === 0 && notKept.length === 0) return null;
  const group = (title: string, entries: typeof withFates, tones: PartFate["tone"][]) =>
    entries.length === 0 ? null : (
      <div className="flex flex-col gap-1">
        <div className="font-display text-[13px] font-semibold text-coal">{title}</div>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map(({ part, fates }) => {
            const origin = originLabel(part.origin);
            return (
              <li key={part.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-body text-[12px] leading-[1.5] text-neutral-800">
                <Button
                  variant="text"
                  className="font-medium text-mariner underline-offset-2 hover:underline"
                  onClick={() => onShow(part.id)}
                >
                  {part.title}
                </Button>
                <span className="font-mono text-[10px] text-neutral-600">
                  {origin.kind}
                  {origin.detail ? `, ${origin.detail}` : ""}
                </span>
                <span className="basis-full">
                  {fates
                    .filter((fate) => tones.includes(fate.tone))
                    .map((fate) => fate.sentence)
                    .join(" ")}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <div className="flex flex-col gap-2 rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2.5">
      {group("What the agent did not get", notGiven, ["lost", "deliberate"])}
      {group("What we did not keep", notKept, ["kept"])}
    </div>
  );
}

function SectionReader({
  runId,
  briefingId,
  header,
  reveal,
}: {
  runId: string;
  briefingId: string;
  header: AgentBriefingSectionHeader;
  reveal: PartReveal | null;
}) {
  const base = `${runId}/${briefingId}/sections/${header.index}`;
  const parts = usePagedSequence<ListPageRead<AgentBriefingPart>, string | null>({
    key: header.partCount > 0 ? `${base}/parts` : null,
    first: null,
    fetch: (cursor, signal) =>
      loadVisibility(() => apiClient.briefings.parts(runId, briefingId, header.index, { cursor }, { signal }), readPartsPage),
    nextOf: (page) => page.nextCursor,
    eager: "all",
  });
  const spans = usePagedSequence<ListPageRead<AgentBriefingRedactionSpan>, string | null>({
    key: header.spanCount > 0 ? `${base}/spans` : null,
    first: null,
    fetch: (cursor, signal) =>
      loadVisibility(() => apiClient.briefings.spans(runId, briefingId, header.index, { cursor }, { signal }), readSpansPage),
    nextOf: (page) => page.nextCursor,
    eager: "all",
  });
  const text = usePagedSequence<AgentBriefingSectionPage, number>({
    key: `${base}/text`,
    first: 0,
    fetch: (offset, signal) =>
      loadVisibility(
        () => apiClient.briefings.sectionText(runId, briefingId, header.index, offset, { signal }),
        readSectionPage,
      ),
    nextOf: (page) => page.nextOffset,
    eager: "first",
  });

  const partItems = React.useMemo(() => listItems(parts.pages), [parts.pages]);
  const spanItems = React.useMemo(() => listItems(spans.pages), [spans.pages]);
  const reading = React.useMemo(() => {
    try {
      return { ok: true as const, value: readSection(text.pages, partItems, spanItems) };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
    }
  }, [text.pages, partItems, spanItems]);

  const panelRef = React.useRef<HTMLDivElement>(null);
  const [focused, setFocused] = React.useState<string | null>(null);
  const scrollPending = React.useRef(false);

  const show = React.useCallback(
    (partId: string) => {
      const part = partItems.find((entry) => entry.id === partId);
      if (!part) return;
      setFocused(partId);
      scrollPending.current = true;
      const { start, end } = part.range;
      void text.loadUntil((pages) => {
        const last = pages.at(-1);
        const loaded = last ? pageEndByte(last) : 0;
        return loaded > start || (start === end && loaded >= start);
      });
    },
    [partItems, text],
  );

  React.useEffect(() => {
    if (reveal && reveal.sectionIndex === header.index) show(reveal.partId);
    // A reveal is acted on once, when it arrives or its parts do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, partItems.length > 0]);

  React.useEffect(() => {
    if (!scrollPending.current || focused === null) return;
    const element = panelRef.current?.querySelector(`[data-part-id="${CSS.escape(focused)}"]`);
    if (element) {
      scrollPending.current = false;
      element.scrollIntoView({ block: "nearest" });
    }
  }, [focused, reading]);

  const partsUnreadable = unreadableCount(parts.pages);
  const loadedBytes = reading.ok ? reading.value.loadedBytes : 0;
  const visible = reading.ok ? reading.value.parts.filter((entry) => entry.loaded !== "none") : [];
  const hiddenParts = reading.ok ? reading.value.parts.length - visible.length : 0;

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-col gap-1 font-body text-[12px] leading-[1.5] text-neutral-700">
        <span>
          {sectionKindLabel(header.kind)}: {formatBytes(header.sentBytes)} sent
          {header.truncatedForStorage ? `, ${formatBytes(header.storedBytes)} kept` : ""},{" "}
          {plural(header.partCount, "part")}
          {header.redactionCount > 0 ? `, ${plural(header.redactionCount, "redaction")}` : ""}.{" "}
          <span className="font-mono text-[10px] text-neutral-600" title={header.sentSha256}>
            sha256 as sent {shortDigest(header.sentSha256)}
          </span>
        </span>
        {header.provenanceCount > 0 ? (
          <span>
            From{" "}
            {header.provenance
              .map((entry) =>
                [entry.kind, entry.id ?? (entry.idWithheld ? withheldKeyLabel(entry.idWithheld) : "no key"), entry.version === null ? null : `v${entry.version}`]
                  .filter(Boolean)
                  .join(" "),
              )
              .join("; ")}
            {header.provenanceCount > header.provenance.length
              ? `; and ${header.provenanceCount - header.provenance.length} more`
              : ""}
            .
          </span>
        ) : null}
      </div>
      {header.truncatedForStorage ? (
        <Notice>
          The agent got all {formatBytes(header.redactedBytes)} of this section; our storage budget kept the first{" "}
          {formatBytes(header.storedBytes)}. Nothing after that point is shown here.
        </Notice>
      ) : null}
      {!header.redactionListComplete ? (
        <Notice>
          This section has {plural(header.redactionCount, "redaction")} and not all of them are listed, so a
          {" [REDACTED]"} marker past the listed ones may be ours or text a person wrote.
        </Notice>
      ) : null}

      {parts.failure ? (
        <LoadFailureNotice failure={parts.failure} what="This section's parts" onRetry={() => void parts.loadAll()} />
      ) : null}
      {partsUnreadable > 0 ? (
        <Notice>
          {plural(partsUnreadable, "part entry", "part entries")} could not be read; their text shows as not attributed.
        </Notice>
      ) : null}
      {parts.done ? <Omissions parts={partItems} onShow={show} /> : parts.loading ? <Loading label="Loading the parts of this section…" /> : null}
      {spans.failure ? (
        <LoadFailureNotice
          failure={spans.failure}
          what="Where this section was redacted"
          onRetry={() => void spans.loadAll()}
        />
      ) : null}

      <div
        ref={panelRef}
        className="@container max-h-[70vh] min-w-0 overflow-y-auto rounded-[3px] bg-neutral-1000"
        data-section-panel={header.index}
      >
        {reading.ok ? (
          <>
            {visible.map((entry) => (
              <PartRow key={entry.part.id} reading={entry} focused={focused === entry.part.id} />
            ))}
            {reading.value.unattributed ? (
              <div className="grid grid-cols-1 border-t border-neutral-800 first:border-t-0 @xl:grid-cols-[184px_minmax(0,1fr)]">
                <div className="border-l-2 border-l-transparent px-3 py-2 @xl:border-r @xl:border-r-neutral-800">
                  <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-500">
                    Not yet attributed
                  </span>
                  <p className="m-0 mt-1 font-body text-[11px] leading-[1.4] text-neutral-400">
                    {parts.failure
                      ? "The part list did not load, so this text is not tied to a part."
                      : "The part list is still loading."}
                  </p>
                </div>
                <pre className="m-0 min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-neutral-200 [overflow-wrap:anywhere]">
                  <Pieces pieces={reading.value.unattributed} />
                </pre>
              </div>
            ) : null}
            {/* A read that failed says nothing about the record: the notice
                below this panel is what speaks. Claiming the section kept no
                text while its header says 73.8 KB is the one lie this view
                must never tell. */}
            {visible.length === 0 && !reading.value.unattributed && !text.failure && !parts.failure ? (
              <p className="m-0 px-3 py-3 font-body text-[12px] text-neutral-400">
                {text.loading || parts.loading ? "Loading the text…" : "This section kept no text."}
              </p>
            ) : null}
          </>
        ) : (
          <p role="alert" className="m-0 px-3 py-3 font-body text-[12px] text-neutral-200">
            The parts of this section do not line up with its text, so it cannot be shown part by part: {reading.message}
          </p>
        )}
      </div>

      {text.failure ? (
        <LoadFailureNotice failure={text.failure} what="This section's text" onRetry={() => void text.loadMore()} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!text.done ? (
          <>
            <span className="font-body text-[12px] text-neutral-700">
              {formatBytes(loadedBytes)} of {formatBytes(header.storedBytes)} loaded
              {hiddenParts > 0 ? `; ${plural(hiddenParts, "more part")} below` : ""}.
            </span>
            <Button variant="secondary" size="sm" loading={text.loading} onClick={() => void text.loadMore()}>
              Load the next page
            </Button>
            <Button variant="ghost" size="sm" disabled={text.loading} onClick={() => void text.loadAll()}>
              Load the rest
            </Button>
          </>
        ) : null}
        <SectionCopy header={header} text={text} />
      </div>
    </div>
  );
}

/** A section in the list: its header, and its reader when open. */
export function SectionRow({
  runId,
  briefingId,
  header,
  open,
  onToggle,
  reveal,
}: {
  runId: string;
  briefingId: string;
  header: AgentBriefingSectionHeader;
  open: boolean;
  onToggle: () => void;
  reveal: PartReveal | null;
}) {
  return (
    <li className="border-t border-neutral-200 first:border-t-0">
      <Button
        variant="text"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-1 py-2 text-left hover:bg-app-bg [&>span]:w-full"
      >
        <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <CaretRightIcon
            aria-hidden="true"
            size={12}
            className={`shrink-0 text-neutral-600 transition-transform duration-[var(--motion-fast)] ${open ? "rotate-90" : ""}`}
          />
          <span className="w-5 shrink-0 font-mono text-[10px] text-neutral-500">{header.index + 1}</span>
          {/* A basis, so on a phone the badges wrap below the title instead of
              squeezing it into a column three letters wide (QA at 400 px). */}
          <span className="min-w-0 flex-1 basis-40 break-words font-display text-[14px] font-medium text-coal">{header.title}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <CkChip>{sectionKindLabel(header.kind)}</CkChip>
            <span className="font-mono text-[10px] text-neutral-600">{formatBytes(header.sentBytes)}</span>
            {header.truncatedForStorage ? <CkChip tone="warn">kept {formatBytes(header.storedBytes)}</CkChip> : null}
            {header.redactionCount > 0 ? <CkChip tone="warn">{plural(header.redactionCount, "redaction")}</CkChip> : null}
          </span>
        </span>
      </Button>
      {open ? (
        <div className="pb-3 pl-0 sm:pl-7">
          <SectionReader runId={runId} briefingId={briefingId} header={header} reveal={reveal} />
        </div>
      ) : null}
    </li>
  );
}
