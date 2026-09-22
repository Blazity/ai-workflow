"use client";

/**
 * One repository question as a round: what was asked, every delivery of an
 * answer (the words, who wrote them, on which surface, how many times they
 * arrived and when, how they were read, what we posted back), and what the
 * record did about it.
 */
import React from "react";

import { Button, CkChip } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import { readDeliveriesPage, readEffectsPage, type ListPageRead } from "@/lib/agent-visibility/contract";
import { describeEffect } from "@/lib/agent-visibility/effects";
import { formatMoment, plural } from "@/lib/agent-visibility/format";
import { loadVisibility } from "@/lib/agent-visibility/load";
import {
  askedBecauseLabel,
  authorLabel,
  readerLabel,
  readingSentence,
  roundStatusLabel,
  roundStatusTone,
  surfaceLabel,
} from "@/lib/agent-visibility/wording";
import type { ClarificationDelivery, ClarificationEffect, ClarificationRoundHeader } from "@shared/agent-visibility";

import { LoadFailureNotice, Loading, Notice } from "./notices";
import { usePagedSequence } from "./paged";

/** One delivery holds up to 20,000 characters of words and a 4,000 character
 *  note, so the round asks for the largest page the worker serves. */
const ROUND_PAGE_BYTES = 524_288;

function Delivery({ delivery, position }: { delivery: ClarificationDelivery; position: number }) {
  return (
    <li className="flex flex-col gap-1.5 border-t border-neutral-200 py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-600">
        <span className="text-neutral-800">{position}.</span>
        <span className="text-coal">{authorLabel(delivery.author)}</span>
        <span className="text-neutral-300">·</span>
        <span>via {surfaceLabel(delivery.surface)}</span>
        <span className="text-neutral-300">·</span>
        <span>
          {delivery.count > 1
            ? `arrived ${plural(delivery.count, "time")}, first ${formatMoment(delivery.firstAt)}, last ${formatMoment(delivery.lastAt)}`
            : `arrived ${formatMoment(delivery.firstAt)}`}
        </span>
      </div>
      <blockquote className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] border-l-2 border-l-neutral-300 bg-app-bg px-2.5 py-1.5 font-body text-[13px] leading-[1.55] text-coal">
        {delivery.words}
      </blockquote>
      <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-800">
        {delivery.reading ? (
          <>
            <span className="font-semibold">Read as:</span> {readingSentence(delivery.reading)}{" "}
            <span className="text-neutral-600">({readerLabel(delivery.reading)})</span>
            {delivery.reading.unofferedNames && delivery.reading.unofferedNames.length > 0 ? (
              <>
                {" "}
                It also named {delivery.reading.unofferedNames.join(", ")}, which the question did not offer.
              </>
            ) : null}
          </>
        ) : (
          <span className="text-neutral-600">This answer was not read for repositories.</span>
        )}
      </p>
      <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-700">
        {delivery.note ? (
          <>
            <span className="font-semibold">We posted back:</span> {delivery.note}
          </>
        ) : (
          "Nothing was posted back for this delivery."
        )}
      </p>
      {delivery.mergeConflict ? (
        <Notice>
          Arrivals of these words were merged across another answer of the same question, so the order in which this
          person said things is lost here.
        </Notice>
      ) : null}
    </li>
  );
}

function Effects({ effects }: { effects: readonly ClarificationEffect[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {effects.map((effect) => {
        const described = describeEffect(effect);
        return (
          <li key={effect.trailId} className="flex flex-col gap-0.5 font-body text-[12px] leading-[1.5] text-neutral-800">
            <span className="font-mono text-[10px] text-neutral-600">{formatMoment(effect.at)}</span>
            <span>
              <span className="font-semibold">{described.title}.</span> {described.detail}
            </span>
            {described.extra ? (
              <span className="break-all font-mono text-[10px] text-neutral-600">{described.extra}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function RoundView({
  subjectKey,
  round,
  open,
  onToggle,
}: {
  subjectKey: string;
  round: ClarificationRoundHeader;
  open: boolean;
  onToggle: () => void;
}) {
  const deliveries = usePagedSequence<ListPageRead<ClarificationDelivery>, string | null>({
    key: open && round.deliveryCount > 0 ? `${subjectKey}/${round.id}/deliveries` : null,
    first: null,
    fetch: (cursor, signal) =>
      loadVisibility(
        () => apiClient.workScope.deliveries(subjectKey, round.id, { cursor, limit: ROUND_PAGE_BYTES }, { signal }),
        readDeliveriesPage,
      ),
    nextOf: (page) => page.nextCursor,
    eager: "first",
  });
  const effects = usePagedSequence<ListPageRead<ClarificationEffect>, string | null>({
    key: open && round.effectCount > 0 ? `${subjectKey}/${round.id}/effects` : null,
    first: null,
    fetch: (cursor, signal) =>
      loadVisibility(
        () => apiClient.workScope.effects(subjectKey, round.id, { cursor, limit: ROUND_PAGE_BYTES }, { signal }),
        readEffectsPage,
      ),
    nextOf: (page) => page.nextCursor,
    eager: "all",
  });
  const deliveryItems = deliveries.pages.flatMap((page) => page.items);
  const effectItems = effects.pages.flatMap((page) => page.items);
  // A round answered before delivery recording existed: the header must say
  // that, not "no answer recorded" beside an "Answered" chip.
  const answeredWithoutWords =
    round.deliveryCount === 0 && (round.status === "answered" || round.status === "resume_failed");

  return (
    <li className="border-t border-neutral-200 first:border-t-0">
      <Button
        variant="text"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-1 py-2.5 text-left hover:bg-app-bg [&>span]:w-full"
      >
        <span className="flex w-full min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <CkChip tone={roundStatusTone(round.status)}>{roundStatusLabel(round.status)}</CkChip>
            <span className="font-mono text-[10px] text-neutral-600">asked {formatMoment(round.question.askedAt)}</span>
            {round.question.askedAgain ? (
              <span className="font-mono text-[10px] text-neutral-600">
                asked again ({plural(round.askCount, "time")} in all)
              </span>
            ) : null}
          </span>
          <span className="min-w-0 break-words font-body text-[13px] leading-[1.5] text-coal">
            {round.question.questions[0] ?? "The question itself was not recorded."}
            {round.question.questionCount > round.question.questions.length
              ? ` (and ${round.question.questionCount - round.question.questions.length} more)`
              : ""}
          </span>
          <span className="font-mono text-[10px] text-neutral-600">
            {round.deliveryCount === 0
              ? answeredWithoutWords
                ? "answered before we kept the words"
                : "no answer recorded"
              : `${plural(round.deliveryCount, "answer")}, ${plural(round.arrivalCount, "arrival")}`}
            {round.effectCount > 0 ? ` · ${plural(round.effectCount, "effect")}` : ""}
          </span>
        </span>
      </Button>
      {open ? (
        <div className="flex flex-col gap-3 px-1 pb-3">
          {round.question.questions.slice(1).map((question) => (
            <p key={question} className="m-0 font-body text-[13px] leading-[1.5] text-coal">
              {question}
            </p>
          ))}
          <div className="flex flex-col gap-1 font-body text-[12px] leading-[1.5] text-neutral-700">
            {round.question.offered === null ? (
              <span>This question was not about repositories.</span>
            ) : round.question.offered.length === 0 ? (
              <span>
                The question named no repository
                {round.question.purpose === "narrowing"
                  ? ": the run held more repositories than it may work on and asked which are essential."
                  : "."}
              </span>
            ) : (
              <span>
                Repositories offered:{" "}
                {round.question.offered
                  .map(
                    (offered) =>
                      `${offered.key} (${askedBecauseLabel(offered.askedBecause)}${
                        offered.named === false ? ", not named in the question's words" : ""
                      })`,
                  )
                  .join("; ")}
                {round.question.offeredCount !== null && round.question.offeredCount > round.question.offered.length
                  ? `, and ${round.question.offeredCount - round.question.offered.length} more`
                  : ""}
                .
              </span>
            )}
            {round.skippedRows > 0 ? (
              <span>{plural(round.skippedRows, "row")} of this round could not be read and is not shown.</span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-600">
              Answers delivered
            </span>
            {round.deliveryCount === 0 ? (
              <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-700">
                {answeredWithoutWords
                  ? "This round was answered before answer deliveries were recorded, so the words are on the ticket and not here."
                  : "Nobody has answered this question yet."}
              </p>
            ) : null}
            {deliveries.failure ? (
              <LoadFailureNotice
                failure={deliveries.failure}
                what="The answers of this round"
                onRetry={() => void deliveries.loadMore()}
              />
            ) : null}
            {deliveries.loading && deliveryItems.length === 0 ? <Loading label="Loading the answers…" /> : null}
            <ul className="m-0 flex list-none flex-col p-0">
              {deliveryItems.map((delivery, position) => (
                <Delivery
                  key={`${delivery.clarificationId}:${delivery.firstAt}:${position}`}
                  delivery={delivery}
                  position={position + 1}
                />
              ))}
            </ul>
            {!deliveries.done && deliveryItems.length > 0 ? (
              <div>
                <Button variant="secondary" size="sm" loading={deliveries.loading} onClick={() => void deliveries.loadMore()}>
                  Load more answers ({deliveryItems.length} of {round.deliveryCount})
                </Button>
              </div>
            ) : null}
          </div>

          {round.effectCount > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-600">
                What the record did
              </span>
              {effects.failure ? (
                <LoadFailureNotice
                  failure={effects.failure}
                  what="What the record did"
                  onRetry={() => void effects.loadAll()}
                />
              ) : null}
              {effects.loading && effectItems.length === 0 ? <Loading label="Loading the decision trail…" /> : null}
              <Effects effects={effectItems} />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
