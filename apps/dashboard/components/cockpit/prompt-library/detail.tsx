"use client";

import { useEffect, useState } from "react";
import { Button, CkCard, CkChip, CkTabs, Skeleton } from "@/components/ui";
import { DiffView } from "@/components/cockpit/prompt-diff";
import { PromptBodyBlocks } from "@/components/cockpit/prompt-library/prompt-body-blocks";
import { promptLibraryHref } from "@shared/prompts";
import type {
  PromptLibraryDetailResponse,
  PromptLibraryListRowDto,
  PromptLibraryUsageResponse,
  PromptLibraryUsageRow,
} from "@shared/contracts";

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
            <Skeleton variant="line" className="w-3/4" />
            <Skeleton variant="line" className="w-1/2" />
          </div>
        </CkCard>
        <CkCard eyebrow="PROMPT BODY">
          <Skeleton height={220} />
        </CkCard>
      </div>
    );
  }

  const meta = detail.meta;
  const versions = detail.versions;
  const archived = meta.archivedAt !== null;
  const shownVersion = selectedVersion ?? meta.currentVersion;
  const shownIdx = versions.findIndex((v) => v.version === shownVersion);
  const shownRecord = shownIdx >= 0 ? versions[shownIdx] : detail.current;
  const shownBody = shownRecord.body;
  const shownSlots = shownRecord.slots;
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
              <Button variant="secondary" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="secondary" onClick={() => setConfirmArchive(true)}>
                Archive
              </Button>
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
            <Button
              variant="danger"
              size="sm"
              onClick={onArchive}
              disabled={busy !== null}
            >
              {busy === "archive" ? "Archiving…" : "Archive"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmArchive(false)}
            >
              Cancel
            </Button>
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
              <Button
                variant={on ? "primary" : "secondary"}
                size="md"
                key={v.version}
                onClick={() => setSelectedVersion(v.version)}
                className={`h-auto w-44 shrink-0 justify-start py-3.5 text-left ${dropRight ? "border-r-0" : ""}`}
              >
                <span className="flex w-full min-w-0 flex-col">
                  <span className="mb-1.5 flex items-center justify-between">
                    <span className="font-mono text-sm font-semibold text-neutral-900">
                      v{v.version}
                    </span>
                    {v.restoredFromVersion !== null && (
                      <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[9px] text-neutral-600">
                        from v{v.restoredFromVersion}
                      </span>
                    )}
                  </span>
                  <span className="mb-1 font-mono text-[10px] text-neutral-500">
                    {new Date(v.createdAt).toLocaleDateString()}
                  </span>
                  <span className="truncate font-mono text-[10px] text-neutral-700">
                    {v.createdByLabel}
                  </span>
                </span>
              </Button>
            );
          })}
        </div>
      </CkCard>

      <CkCard eyebrow={`Prompt body · v${shownVersion}`}>
        {shownSlots.length > 0 && (
          <div className="mb-3 rounded-xs border border-neutral-200 bg-off-white/60 px-3 py-2">
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-600">
              Prompt slots · v{shownVersion}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {shownSlots.map((slot) => (
                <span
                  key={slot.name}
                  title={slot.description || undefined}
                  className="inline-flex items-center gap-1 rounded-full border border-mariner-200 bg-panel px-2 py-1 font-mono text-[9px] text-mariner"
                >
                  ◇ {slot.name}
                  <span className="text-neutral-500">
                    {slot.required ? "required" : "optional"}
                    {Object.hasOwn(slot, "defaultValue") ? " · default" : ""}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <CkTabs tabs={tabs} active={showDiff ? "diff" : showRaw ? "raw" : "preview"} onChange={(id) => setBodyTab(id as "preview" | "raw" | "diff")} />
          <div className="flex items-center gap-3">
            {canRestore &&
              (confirmRestore === shownVersion ? (
                <span className="flex items-center gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onRestore(shownVersion)}
                    disabled={busy !== null}
                  >
                    {busy === `restore-${shownVersion}` ? "Restoring…" : "Confirm restore"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmRestore(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmRestore(shownVersion)}
                >
                  Restore
                </Button>
              ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={copyBody}
            >
              {copied ? "Copied" : "Copy body"}
            </Button>
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
            <Skeleton height={32} />
            <Skeleton height={32} />
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
