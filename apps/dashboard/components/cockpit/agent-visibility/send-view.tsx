"use client";

/**
 * One send: what the harness was told beside the prompt, the prompt section by
 * section, the repositories the send described, and the sources the compiler
 * could not resolve (which is why an expected AGENTS.md may be missing).
 */
import React from "react";

import { Button } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import {
  readSectionHeadersPage,
  readSectionPage,
  readUnresolvedSourcesPage,
  type ListPageRead,
} from "@/lib/agent-visibility/contract";
import { checkStoredText } from "@/lib/agent-visibility/copy-check";
import { formatBytes, formatMoment, plural, shortDigest } from "@/lib/agent-visibility/format";
import { failureSentence, loadVisibility } from "@/lib/agent-visibility/load";
import { sendTitle, withheldKeyLabel } from "@/lib/agent-visibility/wording";
import type { AgentBriefingOverview, AgentBriefingSectionHeader, AgentBriefingUnresolvedSource } from "@shared/agent-visibility";

import { LoadFailureNotice, Loading, Notice } from "./notices";
import { usePagedSequence } from "./paged";
import { RepositoryMap } from "./repository-map";
import { SectionRow, type PartReveal } from "./section-reader";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-600">{label}</dt>
      <dd className="m-0 min-w-0 break-words font-body text-[12px] leading-[1.5] text-neutral-900">{children}</dd>
    </div>
  );
}

function switchLabel(value: boolean | undefined, on: string, off: string): string {
  if (value === undefined) return "not recorded for this send";
  return value ? on : off;
}

function Harness({ overview }: { overview: AgentBriefingOverview }) {
  const { harness } = overview;
  const skills = harness.skills.map((skill) => `${skill.id}${skill.version === null ? "" : ` v${skill.version}`}`);
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      <Fact label="Model">
        <span className="font-mono text-[11px]">{harness.model}</span> ({harness.provider})
      </Fact>
      <Fact label="Output schema">
        {harness.outputSchema ? (
          <span title={harness.outputSchema.sha256}>sent, sha256 {shortDigest(harness.outputSchema.sha256)}</span>
        ) : (
          "none sent"
        )}
      </Fact>
      <Fact label="Harness profile">
        {harness.profile.pinned
          ? `${harness.profile.id ?? (harness.profile.idWithheld ? withheldKeyLabel(harness.profile.idWithheld) : "unknown")} v${harness.profile.version}`
          : "none pinned"}
      </Fact>
      <Fact label={`Skills delivered (${harness.skillCount})`}>
        {skills.length > 0 ? skills.join(", ") : "none"}
        {harness.skillCount > harness.skills.length ? `, and ${harness.skillCount - harness.skills.length} more` : ""}
      </Fact>
      <Fact label="Run data in this prompt">
        {switchLabel(
          harness.includeWorkflowData,
          "included",
          "excluded by the profile, and our own rules went with it",
        )}
      </Fact>
      <Fact label="Repository instructions">
        {switchLabel(harness.includeRepositoryInstructions, "included", "excluded by the profile")}
      </Fact>
      <Fact label="Wrapper script">
        {harness.wrapperScriptSha256 ? (
          <span title={harness.wrapperScriptSha256}>sha256 {shortDigest(harness.wrapperScriptSha256)}</span>
        ) : (
          "none: the model was called in process"
        )}
      </Fact>
    </dl>
  );
}

function UnresolvedSources({
  runId,
  briefingId,
  total,
}: {
  runId: string;
  briefingId: string;
  total: number;
}) {
  const sources = usePagedSequence<ListPageRead<AgentBriefingUnresolvedSource>, string | null>({
    key: `${runId}/${briefingId}/unresolved-sources`,
    first: null,
    fetch: (cursor, signal) =>
      loadVisibility(
        () => apiClient.briefings.unresolvedSources(runId, briefingId, { cursor }, { signal }),
        readUnresolvedSourcesPage,
      ),
    nextOf: (page) => page.nextCursor,
    eager: "all",
  });
  const items = sources.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-700">
        {plural(total, "source")} the compiler asked for and could not read. This is why an instruction file or a
        memory document a person expects may be missing from the sections above.
      </p>
      {sources.failure ? (
        <LoadFailureNotice failure={sources.failure} what="The unresolved sources" onRetry={() => void sources.loadAll()} />
      ) : null}
      {sources.loading && items.length === 0 ? <Loading label="Loading the unresolved sources…" /> : null}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {items.map((source) => (
          <li key={`${source.kind}:${source.reference}`} className="flex flex-col gap-0.5">
            <span className="break-all font-mono text-[11px] text-coal">
              {source.kind} {source.reference}
            </span>
            <span className="font-body text-[12px] leading-[1.5] text-neutral-700">{source.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type WholeCopy =
  | { state: "idle" }
  | { state: "loading"; done: number; of: number }
  | { state: "ready"; text: string; checked: boolean }
  | { state: "copied"; checked: boolean }
  | { state: "failed"; message: string };

/**
 * The whole prompt of one send, in section order, as one copy.
 *
 * Per section the dashboard already proves the bytes; this proves each one and
 * joins them, so a person can paste what the agent read in a ticket or a bug
 * report without reassembling it by hand. Two steps, like the per-section
 * copy: Safari drops the clipboard permission across awaited requests.
 */
function WholePromptCopy({
  runId,
  briefingId,
  sections,
  complete,
}: {
  runId: string;
  briefingId: string;
  sections: readonly AgentBriefingSectionHeader[];
  /** Every section of this send is listed and readable. */
  complete: boolean;
}) {
  const [copy, setCopy] = React.useState<WholeCopy>({ state: "idle" });
  const trimmed = sections.filter((header) => header.truncatedForStorage).length;
  // Counted from the sections this button actually joins, never from the
  // send's own total: the label and the bytes must be the same number.
  const keptBytes = sections.reduce((total, header) => total + header.storedBytes, 0);

  /** Every page of one section's stored text, in order. */
  const readSection = (sectionIndex: number, offset: number) =>
    loadVisibility(() => apiClient.briefings.sectionText(runId, briefingId, sectionIndex, offset), readSectionPage);

  const prepare = async () => {
    setCopy({ state: "loading", done: 0, of: sections.length });
    const parts: string[] = [];
    let checked = true;
    for (const [position, header] of sections.entries()) {
      setCopy({ state: "loading", done: position, of: sections.length });
      const pages: { text: string }[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await readSection(header.index, offset);
        if (!page.ok) {
          setCopy({
            state: "failed",
            message: `${failureSentence(page.failure, `Section ${header.index + 1} of this prompt`)} Nothing was copied.`,
          });
          return;
        }
        pages.push({ text: page.value.text });
        offset = page.value.nextOffset;
      }
      const verdict = await checkStoredText(pages, header);
      if (!verdict.ok) {
        setCopy({ state: "failed", message: `Section ${header.index + 1}: ${verdict.message}` });
        return;
      }
      checked = checked && verdict.digestChecked;
      parts.push(verdict.text);
    }
    setCopy({ state: "ready", text: parts.join(""), checked });
  };

  if (!complete) {
    return (
      <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-600">
        The whole prompt cannot be copied as one: this send's section list is not complete here.
      </p>
    );
  }

  const ready = copy.state === "ready" ? copy : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ready || copy.state === "copied" ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={!ready}
          onClick={() => {
            if (!ready) return;
            navigator.clipboard
              .writeText(ready.text)
              .then(() => setCopy({ state: "copied", checked: ready.checked }))
              .catch((error: unknown) =>
                setCopy({
                  state: "failed",
                  message: `The browser refused to write the clipboard: ${error instanceof Error ? error.message : String(error)}`,
                }),
              );
          }}
        >
          {copy.state === "copied"
            ? "Copied"
            : `Copy the whole prompt (${formatBytes(keptBytes)})`}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" loading={copy.state === "loading"} onClick={() => void prepare()}>
          Prepare the whole prompt to copy
        </Button>
      )}
      <span className="font-body text-[12px] text-neutral-600" role={copy.state === "failed" ? "alert" : undefined}>
        {copy.state === "failed" ? (
          <span className="text-fail-fg">{copy.message}</span>
        ) : copy.state === "loading" ? (
          `Loading section ${copy.done + 1} of ${copy.of}…`
        ) : copy.state === "copied" ? (
          copy.checked
            ? "Every section matched the length and sha256 the worker stored."
            : "Every section matched its stored length; this browser cannot check the sha256 here."
        ) : ready ? (
          `${plural(sections.length, "section")} joined in order, each checked against the stored bytes.`
        ) : (
          `Step 1 of 2: ${plural(sections.length, "section")} are loaded and checked, then one click copies them${
            trimmed > 0 ? `. ${plural(trimmed, "section")} was kept only in part, so the copy is what we kept` : ""
          }.`
        )}
      </span>
    </div>
  );
}

/** A row that opens: the section list, the repository map, the unresolved
 *  sources. */
function Panel({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[3px] border border-neutral-200 bg-panel">
      <Button
        variant="text"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-3 py-2.5 text-left hover:bg-app-bg [&>span]:w-full"
      >
        <span className="flex w-full min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-display text-[14px] font-semibold text-coal">{title}</span>
          <span className="font-body text-[12px] text-neutral-600">{summary}</span>
        </span>
      </Button>
      {open ? <div className="border-t border-neutral-200 px-3 py-3">{children}</div> : null}
    </section>
  );
}

export function SendView({
  runId,
  briefingId,
  overview,
  section,
  onSectionChange,
}: {
  runId: string;
  briefingId: string;
  overview: AgentBriefingOverview;
  /** Which row is open: a section index as text, `map`, `sources`, or null. */
  section: string | null;
  onSectionChange: (section: string | null) => void;
}) {
  const headers = usePagedSequence<ListPageRead<AgentBriefingSectionHeader>, string | null>({
    key: `${runId}/${briefingId}/sections`,
    first: null,
    fetch: (cursor, signal) =>
      loadVisibility(() => apiClient.briefings.sections(runId, briefingId, { cursor }, { signal }), readSectionHeadersPage),
    nextOf: (page) => page.nextCursor,
    eager: "all",
  });
  const sections = headers.pages.flatMap((page) => page.items);
  const unreadable = headers.pages.reduce((total, page) => total + page.unreadable.length, 0);
  const [reveal, setReveal] = React.useState<PartReveal | null>(null);
  const nonce = React.useRef(0);

  // A link can name a section this send does not have: briefings differ
  // between passes, and a link outlives the briefing it was made for.
  const known =
    section === null ||
    section === "map" ||
    section === "sources" ||
    sections.some((header) => String(header.index) === section);
  // Remembered, not derived: the fall-through below opens the default section
  // a moment later, and the person still has to know they are not looking at
  // what the link was made for.
  const [deadSection, setDeadSection] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (sections.length > 0 && !known && section !== null) setDeadSection(section);
  }, [known, section, sections.length]);

  // With nothing asked for, the run's own data is what a person came to read.
  const autoOpened = React.useRef<string | null>(null);
  React.useEffect(() => {
    if ((section !== null && known) || sections.length === 0 || autoOpened.current === briefingId) return;
    autoOpened.current = briefingId;
    const runData = sections.findLast((header) => header.kind === "runtime" || header.kind === "discovery");
    if (runData) onSectionChange(String(runData.index));
    // Once per send, when its sections arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefingId, sections.length, section, known]);

  const showPart = (sectionIndex: number, partId: string) => {
    nonce.current += 1;
    onSectionChange(String(sectionIndex));
    setReveal({ sectionIndex, partId, nonce: nonce.current });
  };

  const { identity, totals } = overview;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h4 className="m-0 font-display text-[16px] font-medium text-coal">{sendTitle(identity)}</h4>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-neutral-700">
          <span>send {identity.sequence}</span>
          <span className="text-neutral-300">·</span>
          <span>{identity.blockType}</span>
          <span className="text-neutral-300">·</span>
          <span>{formatMoment(identity.capturedAt)}</span>
        </div>
        <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-700">
          {plural(totals.sections, "section")}, {formatBytes(totals.sentBytes)} sent to the model
          {totals.storedBytes === totals.sentBytes ? " and kept whole" : `, ${formatBytes(totals.storedBytes)} kept`}
          {totals.redactions > 0 ? `, ${plural(totals.redactions, "redaction")}` : ""}
          {overview.metadataRedactions > 0
            ? `, ${plural(overview.metadataRedactions, "redaction")} in titles and labels`
            : ""}
          .
          {totals.truncatedSections > 0
            ? ` Our ${formatBytes(overview.budgetBytes)} storage budget kept ${plural(totals.truncatedSections, "section")} only in part; the agent got ${
                totals.truncatedSections === 1 ? "it" : "them"
              } whole.`
            : ""}
        </p>
      </div>

      <Harness overview={overview} />

      {deadSection ? (
        <Notice title="The section this link names is not in this send">
          A link carries a section by its place in one send, and passes do not hold the same sections. Showing this
          send's run data instead.
        </Notice>
      ) : null}

      <section className="rounded-[3px] border border-neutral-200 bg-panel">
        <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-neutral-200 px-3 py-2.5">
          <h5 className="m-0 font-display text-[14px] font-semibold text-coal">The prompt, section by section</h5>
          <span className="font-body text-[12px] text-neutral-600">
            {headers.loading && sections.length === 0
              ? "loading"
              : `${plural(sections.length, "section")}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}`}
          </span>
        </header>
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <WholePromptCopy
            runId={runId}
            briefingId={briefingId}
            sections={sections}
            complete={headers.done && unreadable === 0}
          />
        </div>
        <div className="px-3 py-1.5">
          {headers.failure ? (
            <LoadFailureNotice failure={headers.failure} what="The sections of this send" onRetry={() => void headers.loadAll()} />
          ) : null}
          {unreadable > 0 ? <Notice>{plural(unreadable, "section")} could not be read and is not listed.</Notice> : null}
          {headers.loading && sections.length === 0 ? <Loading label="Loading the sections of this send…" /> : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {sections.map((header) => (
              <SectionRow
                key={header.index}
                runId={runId}
                briefingId={briefingId}
                header={header}
                open={section === String(header.index)}
                onToggle={() => onSectionChange(section === String(header.index) ? null : String(header.index))}
                reveal={reveal}
              />
            ))}
          </ul>
        </div>
      </section>

      {overview.repositoryContext ? (
        <Panel
          title="Repositories the agent was told about"
          summary={`${plural(overview.repositoryContext.repositoryCount, "repository", "repositories")}${
            overview.repositoryContext.unlistedCount > 0 ? `, ${overview.repositoryContext.unlistedCount} more as a count` : ""
          }`}
          open={section === "map"}
          onToggle={() => onSectionChange(section === "map" ? null : "map")}
        >
          <RepositoryMap
            runId={runId}
            briefingId={briefingId}
            reference={overview.repositoryContext}
            onShowPart={showPart}
          />
        </Panel>
      ) : (
        <Notice>This send described no repositories to the model.</Notice>
      )}

      {overview.unresolvedSourceCount > 0 ? (
        <Panel
          title="Sources the compiler could not resolve"
          summary={plural(overview.unresolvedSourceCount, "source")}
          open={section === "sources"}
          onToggle={() => onSectionChange(section === "sources" ? null : "sources")}
        >
          <UnresolvedSources runId={runId} briefingId={briefingId} total={overview.unresolvedSourceCount} />
        </Panel>
      ) : null}
    </div>
  );
}
