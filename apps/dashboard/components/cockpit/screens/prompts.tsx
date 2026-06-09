"use client";

import React, { useState, useEffect } from "react";
import { CkCard, CkKPI } from "@/components/ui";
import type { PromptsResponse, PromptDef, PromptVersion } from "@shared/contracts";

const PROMPT_STATUS_COLOR: Record<string, { bg: string; fg: string; dot: string }> = {
  production: { bg: "#EAF7E0", fg: "#3F6B1E", dot: "#5BB04A" },
  staging:    { bg: "#ECECFD", fg: "#3C43E7", dot: "#3C43E7" },
  draft:      { bg: "#FFF4CC", fg: "#7A5A00", dot: "#FFC800" },
  archived:   { bg: "#F2F4F6", fg: "#5F666F", dot: "#9EA3AA" },
  locked:     { bg: "#181B20", fg: "#fff",    dot: "#fff"    },
  arthur:     { bg: "#ECECFD", fg: "#3C43E7", dot: "#3C43E7" },
  fallback:   { bg: "#F2F4F6", fg: "#5F666F", dot: "#9EA3AA" },
};

function PromptStatusChip({ status }: { status: string }) {
  const c = PROMPT_STATUS_COLOR[status] || PROMPT_STATUS_COLOR.archived;
  return (
    <span
      className="inline-flex items-center gap-[5px] px-[7px] py-0.5 rounded-xs font-mono text-[9px] font-medium tracking-[0.04em] uppercase"
      style={{ background: c.bg, color: c.fg }}
    >
      <span className="w-[5px] h-[5px] rounded-full" style={{ background: c.dot }} />
      {status}
    </span>
  );
}

/** The version tagged "production", if any (used for the row's tag chip). */
function productionVersion(p: PromptDef): PromptVersion | undefined {
  return p.versions.find((v) => v.tags.includes("production"));
}

/* ───── Prompts list (left rail) ───── */
function PromptList({
  rows,
  active,
  onSelect,
  arthurEnabled,
}: {
  rows: PromptDef[];
  active: string;
  onSelect: (name: string) => void;
  arthurEnabled: boolean;
}) {
  const [filter, setFilter] = useState("all");
  // Derive the tag filter set from tags that actually occur across all versions.
  const allTags = Array.from(
    new Set(rows.flatMap((p) => p.versions.flatMap((v) => v.tags))),
  );
  const filters = ["all", ...allTags];
  const list =
    filter === "all"
      ? rows
      : rows.filter((p) => p.versions.some((v) => v.tags.includes(filter)));

  return (
    <CkCard
      eyebrow={`${arthurEnabled ? "Arthur" : "In-code"} · ${rows.length} prompts`}
      title="Registry"
      pad={0}
      className="lg:h-full"
      style={{ display: "flex", flexDirection: "column" }}
    >
      {filters.length > 1 && (
        <div className="px-3.5 py-2 border-b border-neutral-200 flex gap-1 flex-wrap">
          {filters.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`appearance-none cursor-pointer px-2 py-1 rounded-xs font-mono text-[9px] font-medium tracking-[0.04em] uppercase border ${filter === t ? "border-coal bg-coal text-white" : "border-neutral-200 bg-panel text-neutral-700"}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {list.map((p, i) => {
          const on = active === p.name;
          const prod = productionVersion(p);
          return (
            <button
              type="button"
              key={p.name}
              onClick={() => onSelect(p.name)}
              className={`block w-full appearance-none text-left px-4 py-[14px] cursor-pointer transition-all duration-100 border-l-[3px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-2px] ${i < list.length - 1 ? "border-b border-b-neutral-200" : ""} ${on ? "border-l-mariner bg-off-white" : "border-l-transparent bg-panel hover:bg-[#FAFBFC]"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[13px] font-semibold text-neutral-900">{p.name}</span>
                <span className="font-mono text-[10px] text-mariner font-semibold">{p.model}</span>
              </div>
              <div className="text-[11px] text-neutral-500 mt-[3px]">{p.phase}</div>
              <div className="flex items-center gap-1.5 mt-1.5">
                {prod && <PromptStatusChip status="production" />}
                <PromptStatusChip status={p.source} />
              </div>
            </button>
          );
        })}
      </div>
    </CkCard>
  );
}

/* ───── Mini stat (used in prompt header) ───── */
function Stat({ label, value, sub }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-neutral-700 tracking-[0.06em] uppercase">{label}</div>
      <div className="font-display font-medium text-[26px] leading-[1.1] tracking-[-0.02em] text-neutral-900 mt-1">{value}</div>
      {sub && <div className="font-mono text-[11px] mt-0.5 text-neutral-500">{sub}</div>}
    </div>
  );
}

/* ───── Selected-prompt detail (right pane) ───── */
function PromptDetail({ prompt }: { prompt: PromptDef | undefined }) {
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [bodyCache, setBodyCache] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);

  // Reset the selected historical version whenever the active prompt changes —
  // default view is always the resolved production body.
  useEffect(() => {
    setSelectedVersion(null);
  }, [prompt?.name]);

  if (!prompt) {
    return (
      <CkCard style={{ height: "100%" }}>
        <div className="p-10 text-center text-neutral-500 font-body">Select a prompt to inspect.</div>
      </CkCard>
    );
  }

  async function showVersion(v: PromptVersion) {
    if (!prompt) return;
    setSelectedVersion(v.version);
    if (v.body !== undefined) {
      setBodyCache((c) => ({ ...c, [v.version]: v.body! }));
      return;
    }
    if (bodyCache[v.version] !== undefined) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/prompts/${encodeURIComponent(prompt.name)}/versions/${v.version}`,
      );
      const json = (await res.json()) as { body: string | null };
      setBodyCache((c) => ({ ...c, [v.version]: json.body ?? "(version body unavailable)" }));
    } catch {
      setBodyCache((c) => ({ ...c, [v.version]: "(version body unavailable)" }));
    } finally {
      setLoading(false);
    }
  }

  const shownBody =
    selectedVersion != null
      ? bodyCache[selectedVersion] ?? (loading ? "Loading…" : "")
      : prompt.body;
  const shownLabel = selectedVersion != null ? `v${selectedVersion}` : "production";

  return (
    <div className="flex flex-col gap-3 lg:h-full">
      <CkCard
        eyebrow={`${prompt.source === "arthur" ? "Arthur" : "In-code"} · ${prompt.phase}`}
        title={prompt.name}
        action={
          <div className="flex items-center gap-2">
            <PromptStatusChip status={prompt.source} />
            <span className="w-px h-4 bg-neutral-200" />
            <button className="appearance-none border border-neutral-200 bg-panel px-3 py-1.5 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">+ New version</button>
            <button className="appearance-none border border-coal bg-coal text-white px-3 py-1.5 rounded-[3px] font-mono text-[11px] uppercase tracking-[0.04em] cursor-pointer">Deploy</button>
          </div>
        }
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Phase" value={prompt.phase} />
          <Stat label="Source" value={prompt.source} />
          <Stat label="Model" value={prompt.model} />
          <Stat label="Versions" value={prompt.versions.length} sub="in Arthur" />
        </div>
      </CkCard>

      {/* Version timeline (real Arthur metadata) */}
      {prompt.versions.length > 0 && (
        <CkCard
          eyebrow="Version timeline"
          title="History"
          action={
            <span className="font-mono text-[10px] text-neutral-700 tracking-[0.04em] uppercase">
              Click to inspect
            </span>
          }
        >
          <div className="flex flex-col lg:flex-row lg:items-stretch gap-0">
            {prompt.versions.map((v, i) => {
              const on = selectedVersion === v.version;
              const notLast = i < prompt.versions.length - 1;
              const dropDesktopRight = notLast && !on;
              return (
                <button
                  key={v.version}
                  onClick={() => showVersion(v)}
                  className={`lg:flex-1 appearance-none cursor-pointer text-left px-4 py-[14px] relative border ${on ? "border-[#3C43E7]" : "border-[#E6E8EB]"} ${notLast ? "border-b-0" : ""} lg:border-b ${dropDesktopRight ? "lg:border-r-0" : "lg:border-r"} ${on ? "bg-mariner-100" : "bg-panel"}`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-mono text-sm font-semibold text-neutral-900">v{v.version}</span>
                    <div className="flex gap-1">
                      {v.tags.map((t) => <PromptStatusChip key={t} status={t} />)}
                    </div>
                  </div>
                  <div className="font-mono text-[10px] text-neutral-500 mb-2">{v.createdAt}</div>
                  <div className="grid grid-cols-2 gap-1 font-mono text-[10px]">
                    <span className="text-neutral-700">model</span><span className="text-neutral-900 text-right">{v.modelName}</span>
                    <span className="text-neutral-700">messages</span><span className="text-neutral-900 text-right">{v.numMessages}</span>
                    <span className="text-neutral-700">tools</span><span className="text-neutral-900 text-right">{v.numTools}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </CkCard>
      )}

      {/* Body panel (single column, read-only) */}
      <CkCard
        eyebrow="Prompt body · text"
        title={shownLabel}
        action={
          selectedVersion != null ? (
            <button
              onClick={() => setSelectedVersion(null)}
              className="appearance-none border border-neutral-200 bg-panel px-3 py-1.5 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer"
            >
              Show production
            </button>
          ) : undefined
        }
      >
        <div className="border border-neutral-200 rounded-xs overflow-hidden max-h-[420px]">
          <div className="overflow-auto max-h-[420px] font-mono text-[11px] leading-[1.55] bg-panel text-neutral-900 whitespace-pre-wrap break-words p-3">
            {shownBody}
          </div>
        </div>
      </CkCard>
    </div>
  );
}

/* ───── Top-level screen ───── */
export function PromptsScreen({ data }: { data: PromptsResponse }) {
  const [active, setActive] = useState(data.rows[0]?.name ?? "");
  const selected = data.rows.find((p) => p.name === active);
  const inProd = data.rows.filter((p) =>
    p.versions.some((v) => v.tags.includes("production")),
  ).length;

  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[10px] text-neutral-500 tracking-[0.06em] uppercase">
            {data.arthurEnabled ? "Arthur engine · prompt versioning" : "In-code defaults · prompt versioning"}
          </div>
          <h2 className="font-display font-medium text-2xl leading-[1.2] m-0 text-neutral-900">Prompt registry</h2>
        </div>
        <div className="flex gap-2">
          <button className="appearance-none border border-neutral-200 bg-panel px-3.5 py-2 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">Import from prod</button>
          <button className="appearance-none border border-coal bg-coal text-white px-3.5 py-2 rounded-[3px] font-mono text-[11px] uppercase tracking-[0.04em] cursor-pointer">+ New prompt</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <CkKPI label="Prompts" value={data.total.toString()} sub="workflow phases" />
        <CkKPI
          label="In production"
          value={inProd.toString()}
          sub={data.arthurEnabled ? "tagged in Arthur" : "in-code defaults"}
        />
      </div>

      <div className="flex flex-col lg:grid lg:grid-cols-[340px_1fr] gap-3 lg:min-h-[720px]">
        <PromptList rows={data.rows} active={active} onSelect={setActive} arthurEnabled={data.arthurEnabled} />
        <PromptDetail prompt={selected} />
      </div>
    </div>
  );
}
