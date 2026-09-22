"use client";

/**
 * The repositories one send described to the agent: what each is for, whose
 * words the description was, how they relate, what the agent may do with each
 * and why it is in the map at all. This is the structured record of the map
 * the agent read; `Show the line the agent read` jumps to the text itself.
 */
import React from "react";

import { Button, CkChip } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import { readRepositoryContextPage, type RepositoryContextRead } from "@/lib/agent-visibility/contract";
import { formatBytes, formatMoment, plural } from "@/lib/agent-visibility/format";
import { loadVisibility } from "@/lib/agent-visibility/load";
import {
  actorLabel,
  descriptionSource,
  entryOriginLabel,
  entryStateLabel,
  entryStateTone,
  inclusionSentence,
  relationshipLine,
  renderingLabel,
  repositoryStateLabel,
  repositoryStateTone,
} from "@/lib/agent-visibility/wording";
import type { AgentBriefingRepository, AgentBriefingRepositoryContextRef } from "@shared/agent-visibility";

import { LoadFailureNotice, Loading, Notice } from "./notices";
import { usePagedSequence } from "./paged";

/** A page holds whole entries; a catalog description may be 24,000 characters,
 *  so the map asks for the largest page the worker serves. */
const MAP_PAGE_BYTES = 524_288;

function Text({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-600">{label}</span>
      <p className="m-0 max-h-[200px] overflow-auto whitespace-pre-wrap break-words font-body text-[12px] leading-[1.55] text-neutral-800">
        {value}
      </p>
    </div>
  );
}

function RepositoryEntry({ repository }: { repository: AgentBriefingRepository }) {
  const entry = repository.workScopeEntry;
  return (
    <li className="flex flex-col gap-2 border-t border-neutral-200 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="break-all font-mono text-[12px] font-medium text-coal">{repository.key}</span>
        <CkChip tone={repositoryStateTone(repository.state)}>{repositoryStateLabel(repository.state)}</CkChip>
        <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500">
          {renderingLabel(repository.rendering)}
        </span>
      </div>
      {repository.reason ? (
        <p className="m-0 font-body text-[12px] leading-[1.5] text-fail-fg">{repository.reason}</p>
      ) : null}
      <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-700">{inclusionSentence(repository.inclusion)}</p>
      <Text
        label={descriptionSource(repository.description.source)}
        value={repository.description.text || "The agent was given no description for this repository."}
      />
      {repository.rules ? <Text label="Rules the agent read" value={repository.rules} /> : null}
      {repository.relationships.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-600">
            Relationships
          </span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-body text-[12px] text-neutral-800">
            {repository.relationships.map((relationship) => (
              <li key={`${relationship.kind}:${relationship.target}`} className="break-words">
                {relationshipLine(relationship)}
              </li>
            ))}
            {repository.relationshipCount > repository.relationships.length ? (
              <li className="text-neutral-600">
                and {repository.relationshipCount - repository.relationships.length} more not shown
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {entry ? (
        <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-700">
          Record: <CkChip tone={entryStateTone(entry.state)}>{entryStateLabel(entry)}</CkChip>{" "}
          {actorLabel(entry.decidedBy)} on {formatMoment(entry.decidedAt)} ({entryOriginLabel(entry.origin)})
          {entry.rationale ? `: ${entry.rationale}` : ""}
        </p>
      ) : null}
    </li>
  );
}

export function RepositoryMap({
  runId,
  briefingId,
  reference,
  onShowPart,
}: {
  runId: string;
  briefingId: string;
  reference: AgentBriefingRepositoryContextRef;
  onShowPart: (sectionIndex: number, partId: string) => void;
}) {
  const context = usePagedSequence<RepositoryContextRead, string | null>({
    key: `${runId}/${briefingId}/repository-context`,
    first: null,
    fetch: (cursor, signal) =>
      loadVisibility(
        () => apiClient.briefings.repositoryContext(runId, briefingId, { cursor, limit: MAP_PAGE_BYTES }, { signal }),
        readRepositoryContextPage,
      ),
    nextOf: (page) => page.repositories.nextCursor,
    eager: "first",
  });

  const document = context.pages[0];
  const repositories = context.pages.flatMap((page) => page.repositories.items);
  const unreadable = context.pages.reduce((total, page) => total + page.repositories.unreadable.length, 0);
  const shortened = context.pages.reduce((total, page) => total + page.repositories.shortened.length, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 font-body text-[12px] leading-[1.5] text-neutral-700">
        <span>
          {plural(reference.repositoryCount, "repository", "repositories")} described to the agent
          {reference.unlistedCount > 0
            ? `, and ${plural(reference.unlistedCount, "more repository", "more repositories")} summarized as a count`
            : ""}
          . {formatBytes(reference.bytes)} of structured context
          {reference.redactionCount > 0 ? `, ${plural(reference.redactionCount, "redaction")} inside it` : ""}.
        </span>
        <span>
          {reference.workScopeVersion === null
            ? "This work keeps no repository record."
            : `Repository record version ${reference.workScopeVersion}${
                reference.leftOutCount > 0 ? `, ${plural(reference.leftOutCount, "repository", "repositories")} a person left out` : ""
              }.`}
        </span>
        {document?.workScope && document.workScope.leftOutKeys.length > 0 ? (
          <span className="break-words font-mono text-[11px] text-neutral-600">
            Left out: {document.workScope.leftOutKeys.join(", ")}
          </span>
        ) : null}
      </div>
      {reference.renderedAt ? (
        <div>
          <Button variant="secondary" size="sm" onClick={() => onShowPart(reference.renderedAt!.sectionIndex, reference.renderedAt!.partId)}>
            Show the map as the agent read it
          </Button>
        </div>
      ) : (
        <Notice>This send recorded the map as data; where its text sat in the prompt was not recorded.</Notice>
      )}
      {context.failure ? (
        <LoadFailureNotice failure={context.failure} what="The repositories of this send" onRetry={() => void context.loadMore()} />
      ) : null}
      {unreadable > 0 ? (
        <Notice>{plural(unreadable, "repository entry", "repository entries")} could not be read and is not listed.</Notice>
      ) : null}
      {shortened > 0 ? (
        <Notice>
          {plural(shortened, "entry", "entries")} had its long text shortened by the worker to fit one page; the
          agent got the whole text.
        </Notice>
      ) : null}
      {context.loading && repositories.length === 0 ? <Loading label="Loading the repositories of this send…" /> : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {repositories.map((repository) => (
          <RepositoryEntry key={repository.key} repository={repository} />
        ))}
      </ul>
      {!context.done && repositories.length > 0 ? (
        <div>
          <Button variant="secondary" size="sm" loading={context.loading} onClick={() => void context.loadMore()}>
            Load more repositories ({repositories.length} of {reference.repositoryCount})
          </Button>
        </div>
      ) : null}
    </div>
  );
}
