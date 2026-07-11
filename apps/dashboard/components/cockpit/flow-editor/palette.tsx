"use client";

import { NODE_CATEGORIES } from "./blocks";
import type { PaletteItem } from "./blocks";

export function NodePalette({ items, onAdd }: { items: PaletteItem[]; onAdd: (item: PaletteItem) => void }) {
  return (
    <aside className="w-52 flex-[0_0_208px] bg-panel border-r border-neutral-200 flex flex-col overflow-hidden">
      <div className="pt-[14px] px-[14px] pb-[10px] border-b border-neutral-200 flex flex-col gap-1">
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">Add step</div>
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.04em]">Drag onto canvas, or click to add</div>
      </div>
      <div className="flex-1 overflow-auto py-2 flex flex-col">
        {items.map((it) => {
          const cat = NODE_CATEGORIES[it.type];
          return (
            <button
              key={it.type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-flow-node", JSON.stringify(it));
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(it)}
              className="appearance-none text-left mx-2 my-px py-2 px-2 border border-neutral-200 rounded-[3px] flex items-center gap-2 cursor-grab active:cursor-grabbing bg-panel transition-colors duration-[120ms]"
              onMouseEnter={(e) => (e.currentTarget.style.background = cat.soft)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
            >
              <span
                className="w-[18px] h-[18px] rounded-xs text-white inline-flex items-center justify-center font-mono text-[11px] font-bold flex-[0_0_18px]"
                style={{ background: cat.color }}
              >{cat.glyph}</span>
              <span className="font-body text-xs text-coal overflow-hidden text-ellipsis whitespace-nowrap">{it.name}</span>
              <span className="ml-auto font-mono text-[12px] text-neutral-500 leading-none">+</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export function MobilePaletteList({ items, onAdd }: { items: PaletteItem[]; onAdd: (item: PaletteItem) => void }) {
  return (
    <div className="flex flex-col py-1">
      {items.map((it) => {
        const cat = NODE_CATEGORIES[it.type];
        return (
          <button
            key={it.type}
            onClick={() => onAdd(it)}
            className="appearance-none text-left border-none cursor-pointer flex items-center gap-3 px-[18px] py-3.5 bg-transparent active:bg-app-bg"
          >
            <span
              className="w-[22px] h-[22px] rounded-xs text-white inline-flex items-center justify-center font-mono text-[12px] font-bold flex-[0_0_22px]"
              style={{ background: cat.color }}
            >{cat.glyph}</span>
            <span className="font-body text-[15px] text-coal">{it.name}</span>
          </button>
        );
      })}
    </div>
  );
}
