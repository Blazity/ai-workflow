"use client";

import { useEffect, useState } from "react";
import { CkCard, CkChip, CkTabs } from "@/components/ui";
import { Block } from "@/app/skeleton-block";
import { DiffView } from "@/components/cockpit/prompt-diff";
import { PromptBodyBlocks } from "@/components/cockpit/prompt-library/prompt-body-blocks";
import { promptLibraryHref } from "@/lib/prompt-library/reference-navigation";
import type {
  PromptLibraryDetailResponse,
  PromptLibraryListRowDto,
  PromptLibraryUsageResponse,
  PromptLibraryUsageRow,
} from "@shared/contracts";

const headerButtonClass =
  "appearance-none cursor-pointer border border-neutral-200 bg-panel text-coal py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase hover:bg-app-bg";

function UsageStateChip({
  state,
  version,
  currentVersion,
}: {
  state: PromptLibraryUsageRow["state"];
  version: number;
  currentVersion: number;
}) {
  if (state === "current") return <CkChip tone="success">in sync</CkChip>;
  if (state === "behind")
    return (
      <CkChip tone="warn">
        v{version} of v{currentVersion}
      </CkChip>
    );
  return <CkChip tone="orange">edited copy</CkChip>;
}

export function PromptDetail({
  row,
  detail,
  usage,
  canEdit,
  busy,
  onEdit,
  onArchive,
  onRestore,
}: {
  row: PromptLibraryListRowDto;
  detail: PromptLibraryDetailResponse | undefined;
  usage: PromptLibraryUsageResponse | undefined;
  canEdit: boolean;
  busy: string | null;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: (version: number) => void;
}) {
  // null selected version = show the head; any other value = an inspected version.
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [bodyTab, setBodyTab] = useState<"preview" | "raw" | "diff">("preview");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const currentVersion = detail?.meta.currentVersion ?? row.currentVersion;
  // Reset the inspected version whenever the prompt changes or a new head lands
  // (save/restore bump currentVersion), so the view falls back to the head.
  useEffect(() => {
    setSelectedVersion(null);
    setBodyTab("preview");
    setConfirmArchive(false);
    setConfirmRestore(null);
  }, [row.id, currentVersion]);

  if (!detail) {
    return (
      <div className="flex flex-col gap-3 lg:h-full min-w-0">
        <CkCard eyebrow={`LIBRARY · v${row.currentVersion}`} title={row.name}>
          <div className="flex flex-col gap-2">
            <Block className="h-4 w-3/4" />
            <Block className="h-4 w-1/2" />
          </div>
        </CkCard>
        <CkCard eyebrow="PROMPT BODY">
          <Block className="h-[220px] w-full" />
        </CkCard>
      </div>
    );
  }

  const meta = detail.meta;
  const versions = detail.versions;
  const archived = meta.archivedAt !== null;
  const shownVersion = selectedVersion ?? meta.currentVersion;
  const shownIdx = versions.findIndex((v) => v.version === shownVersion);
  const shownBody = shownIdx >= 0 ? versions[shownIdx].body : detail.current.body;
  const prev = shownIdx >= 0 ? versions[shownIdx + 1] : undefined;
  const canDiff = prev !== undefined;
  const isHead = shownVersion === meta.currentVersion;
  const canRestore = canEdit && !archived && !isHead;
  const usageTotal = usage ? usage.rows.length + usage.prompts.length : 0;

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(shownBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (permissions/insecure context); ignore silently.
    }
  }

  const tabs = [
    { id: "preview", label: "Preview" },
    { id: "raw", label: "Raw" },
    ...(canDiff ? [{ id: "diff", label: "Diff vs previous" }] : []),
  ];
  const showDiff = bodyTab === "diff" && canDiff;
  const showRaw = bodyTab === "raw";

  return (
    <div className="flex flex-col gap-3 lg:h-full min-w-0">
      <CkCard
        eyebrow={`LIBRARY · v${meta.currentVersion}${archived ? " · ARCHIVED" : ""}`}
        title={meta.name}
        action={
          canEdit && !archived ? (
            <div className="flex items-center gap-2">
              <button onClick={onEdit} className={headerButtonClass}>
                Edit
              </button>
              <button onClick={() => setConfirmArchive(true)} className={headerButtonClass}>
                Archive
              </button>
            </div>
          ) : undefined
        }
      >
        {confirmArchive && (
          <div className="mb-3 flex items-center gap-3 flex-wrap font-body text-[12px] text-neutral-700">
            <span>
              Archive this prompt?{" "}
              {usageTotal > 0
                ? `${usageTotal} ${usageTotal === 1 ? "place references" : "places reference"} it; live references will stop resolving on latest. Copied text keeps working.`
                : "Nothing references it."}
            </span>
            <button
              onClick={onArchive}
              disabled={busy !== null}
              className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
            >
              {busy === "archive" ? "Archiving…" : "Archive"}
            </button>
            <button
              onClick={() => setConfirmArchive(false)}
              className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}
        {meta.description ? (
          <p className="font-body text-[13px] text-neutral-700 m-0">{meta.description}</p>
        ) : (
          <p className="font-body text-[13px] text-neutral-400 m-0">No description.</p>
        )}
      </CkCard>

      <CkCard
        eyebrow="Version timeline"
        title="History"
        action={
          <span className="font-mono text-[10px] text-neutral-700 tracking-[0.04em] uppercase">
            Click to inspect
          </span>
        }
      >
        <div className="flex items-stretch gap-0 overflow-x-auto">
          {versions.map((v, i) => {
            const on = shownVersion === v.version;
            const notLast = i < versions.length - 1;
            const dropRight = notLast && !on;
            return (
              <button
                key={v.version}
                onClick={() => setSelectedVersion(v.version)}
                className={`shrink-0 w-[176px] appearance-none cursor-pointer text-left px-4 py-[14px] relative border ${
                  on ? "border-mariner bg-mariner-100" : "border-neutral-200 bg-panel"
                } ${dropRight ? "border-r-0" : ""}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-sm font-semibold text-neutral-900">
                    v{v.version}
                  </span>
                  {v.restoredFromVersion !== null && (
                    <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[9px] text-neutral-600">
                      from v{v.restoredFromVersion}
                    </span>
                  )}
                </div>
                <div className="font-mono text-[10px] text-neutral-500 mb-1">
                  {new Date(v.createdAt).toLocaleDateString()}
                </div>
                <div className="font-mono text-[10px] text-neutral-700 truncate">
                  {v.createdByLabel}
                </div>
              </button>
            );
          })}
        </div>
      </CkCard>

      <CkCard eyebrow={`Prompt body · v${shownVersion}`}>
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <CkTabs tabs={tabs} active={showDiff ? "diff" : showRaw ? "raw" : "preview"} onChange={(id) => setBodyTab(id as "preview" | "raw" | "diff")} />
          <div className="flex items-center gap-3">
            {canRestore &&
              (confirmRestore === shownVersion ? (
                <span className="flex items-center gap-2">
                  <button
                    onClick={() => onRestore(shownVersion)}
                    disabled={busy !== null}
                    className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                  >
                    {busy === `restore-${shownVersion}` ? "Restoring…" : "Confirm restore"}
                  </button>
                  <button
                    onClick={() => setConfirmRestore(null)}
                    className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmRestore(shownVersion)}
                  className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer"
                >
                  Restore
                </button>
              ))}
            <button
              onClick={copyBody}
              className="appearance-none border-none bg-transparent font-mono text-[11px] tracking-[0.04em] uppercase text-neutral-700 cursor-pointer hover:text-coal"
            >
              {copied ? "Copied" : "Copy body"}
            </button>
          </div>
        </div>
        <div className="border border-neutral-200 rounded-xs overflow-hidden bg-off-white/50">
          <div className="py-3 px-4">
            {showDiff && prev ? (
              <DiffView oldText={prev.body} newText={shownBody} />
            ) : showRaw ? (
              <pre className="m-0 max-h-[480px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] text-coal">
                {shownBody}
              </pre>
            ) : (
              <PromptBodyBlocks body={shownBody} maxHeightClass="max-h-[480px]" />
            )}
          </div>
        </div>
      </CkCard>

      <CkCard eyebrow="Used in" title="Workflows and prompts">
        {usage === undefined ? (
          <div className="flex flex-col gap-2">
            <Block className="h-8 w-full" />
            <Block className="h-8 w-full" />
          </div>
        ) : usage.rows.length === 0 && usage.prompts.length === 0 ? (
          <div className="font-body text-[12px] text-neutral-500">
            Not used in any workflow or prompt yet.
          </div>
        ) : (
          <div className="flex flex-col">
            {usage.rows.map((u, i) => (
              <a
                key={`${u.definitionId}-${u.nodeId}-${u.paramKey}-${i}`}
                href={`/editor?definition=${u.definitionId}&node=${encodeURIComponent(u.nodeId)}`}
                className="flex items-center gap-2 flex-wrap py-2 border-b border-neutral-100 last:border-b-0 no-underline hover:bg-[#FAFBFC]"
              >
                <span className="font-mono text-[12px] font-semibold text-neutral-900">
                  {u.definitionName}
                </span>
                <span className="font-body text-[12px] text-neutral-500">
                  {u.nodeName ?? u.nodeId}
                </span>
                <CkChip tone="neutral">{u.blockType}</CkChip>
                <CkChip tone="neutral">{u.paramKey}</CkChip>
                <span className="ml-auto">
                  <UsageStateChip state={u.state} version={u.version} currentVersion={meta.currentVersion} />
                </span>
              </a>
            ))}
            {usage.prompts.length > 0 && (
              <>
                <div className="mt-3 mb-1 font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500">
                  Prompts
                </div>
                {usage.prompts.map((p) => (
                  <a
                    key={p.promptId}
                    href={promptLibraryHref(p.slug)}
                    className="flex items-center gap-2 flex-wrap py-2 border-b border-neutral-100 last:border-b-0 no-underline hover:bg-[#FAFBFC]"
                  >
                    <span className="font-mono text-[12px] font-semibold text-neutral-900">
                      {p.name}
                    </span>
                    <CkChip tone="neutral">❡ {p.slug}</CkChip>
                    <span className="ml-auto">
                      <UsageStateChip state={p.state} version={p.version} currentVersion={meta.currentVersion} />
                    </span>
                  </a>
                ))}
              </>
            )}
          </div>
        )}
      </CkCard>
    </div>
  );
}
