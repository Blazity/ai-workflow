"use client";

import type { PaletteGroup, PaletteItem } from "./block-palette";
import { Button } from "@/components/ui";

function GroupHeader({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </div>
  );
}

export function NodePalette({ groups, onAdd }: { groups: PaletteGroup[]; onAdd: (item: PaletteItem) => void }) {
  return (
    <aside className="w-52 flex-[0_0_208px] bg-panel border-r border-neutral-200 flex flex-col overflow-hidden">
      <div className="pt-[14px] px-[14px] pb-[10px] border-b border-neutral-200 flex flex-col gap-1">
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">Add step</div>
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.04em]">Drag onto canvas, or click to add</div>
      </div>
      <div className="flex-1 overflow-auto pb-2 flex flex-col">
        {groups.map((grp) => (
          <div key={grp.group} className="flex flex-col">
            <GroupHeader label={grp.label} color={grp.color} />
            {grp.items.map((it) => {
              const cat = it.presentation;
              return (
                <Button
                  key={it.id}
                  variant="secondary"
                  size="sm"
                  draggable={it.available}
                  disabled={!it.available}
                  title={it.unavailableReason ?? cat.description}
                  onDragStart={(e) => {
                    if (!it.available) return;
                    e.dataTransfer.setData("application/x-flow-node", JSON.stringify(it));
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => {
                    if (it.available) onAdd(it);
                  }}
                  className="mx-2 my-px h-auto cursor-grab items-start justify-start px-2 py-2 text-left active:cursor-grabbing [&>span]:w-full"
                >
                  <span
                    className="w-[18px] h-[18px] rounded-xs text-white inline-flex items-center justify-center font-mono text-[11px] font-bold flex-[0_0_18px]"
                    style={{ background: cat.color }}
                  >{cat.glyph}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-body text-xs text-coal overflow-hidden text-ellipsis whitespace-nowrap">{it.name}</span>
                    {it.unavailableReason && (
                      <span className="block mt-0.5 font-body text-[10px] leading-[1.25] text-neutral-500">
                        {it.unavailableReason}
                      </span>
                    )}
                  </span>
                  <span className="ml-auto font-mono text-[12px] text-neutral-500 leading-none">
                    {it.available ? "+" : "×"}
                  </span>
                </Button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

export function MobilePaletteList({ groups, onAdd }: { groups: PaletteGroup[]; onAdd: (item: PaletteItem) => void }) {
  return (
    <div className="flex flex-col py-1">
      {groups.map((grp) => (
        <div key={grp.group} className="flex flex-col">
          <GroupHeader label={grp.label} color={grp.color} />
          {grp.items.map((it) => {
            const cat = it.presentation;
            return (
              <Button
                key={it.id}
                variant="ghost"
                size="sm"
                disabled={!it.available}
                onClick={() => {
                  if (it.available) onAdd(it);
                }}
                className="h-auto w-full items-start justify-start gap-3 px-5 py-3 text-left [&>span]:w-full"
              >
                <span
                  className="w-[22px] h-[22px] rounded-xs text-white inline-flex items-center justify-center font-mono text-[12px] font-bold flex-[0_0_22px]"
                  style={{ background: cat.color }}
                >{cat.glyph}</span>
                <span>
                  <span className="block font-body text-[15px] text-coal">{it.name}</span>
                  {it.unavailableReason && (
                    <span className="block mt-0.5 font-body text-[11px] leading-[1.3] text-neutral-500">
                      {it.unavailableReason}
                    </span>
                  )}
                </span>
              </Button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
