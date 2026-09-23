/**
 * The one rule core cuts memory by before a model or an agent reads it
 * (`fitMemoryText`). What a reader of the result must be able to rely on: it
 * never exceeds the room, it never ends mid-entry when a line end is in reach,
 * a cut always says so, and a text that fits is not touched.
 */
import { describe, expect, it } from "vitest";
import { fitMemoryText, MEMORY_CUT_MARKER, utf8Bytes } from "./content.js";

const lines = (count: number, width = 100) =>
  Array.from({ length: count }, (_, index) => `- entry ${index} `.padEnd(width, "x")).join("\n");

describe("fitMemoryText", () => {
  it("hands back text that fits exactly as it was", () => {
    const text = lines(10);

    expect(fitMemoryText(text, utf8Bytes(text))).toEqual({ text, cut: false });
  });

  it("cuts at the last line end that fits and ends with the marker, inside the room", () => {
    const text = lines(100);
    const room = 2048;

    const fitted = fitMemoryText(text, room);

    expect(fitted?.cut).toBe(true);
    expect(utf8Bytes(fitted?.text ?? "")).toBeLessThanOrEqual(room);
    const kept = (fitted?.text ?? "").split("\n");
    expect(kept.at(-1)).toBe(MEMORY_CUT_MARKER);
    // Every line before the marker is a whole line of the original.
    const original = new Set(text.split("\n"));
    expect(kept.slice(0, -1).every((line) => original.has(line))).toBe(true);
    expect(kept.length - 1).toBeGreaterThan(10);
  });

  it("cuts inside one oversized line rather than keep only what precedes it", () => {
    // A heading and one 20 KiB line: cutting at the line end would keep the
    // heading alone, which is a section that says nothing.
    const text = `# facts\n- ${"z".repeat(20 * 1024)}`;

    const fitted = fitMemoryText(text, 4096);

    expect(fitted?.text.startsWith("# facts\n- zzz")).toBe(true);
    expect(fitted?.text.endsWith(`\n${MEMORY_CUT_MARKER}`)).toBe(true);
    expect(utf8Bytes(fitted?.text ?? "")).toBeLessThanOrEqual(4096);
  });

  it("never splits a character", () => {
    const text = "ż".repeat(4096);

    const fitted = fitMemoryText(text, 2049);

    expect(fitted?.text).not.toContain("�");
    expect(utf8Bytes(fitted?.text ?? "")).toBeLessThanOrEqual(2049);
  });

  it("leaves text out when too little room is left to be worth a section", () => {
    expect(fitMemoryText(lines(100), 512)).toBeNull();
  });
});
