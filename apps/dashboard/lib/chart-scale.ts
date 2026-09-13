export interface NiceScale {
  max: number;
  step: number;
  ticks: number[];
}

function niceCeiling(value: number): number {
  if (value <= 0 || !Number.isFinite(value)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** A zero-based, equally spaced scale whose top tick always contains the data. */
export function niceScale(values: readonly number[], intervals = 2): NiceScale {
  const dataMax = Math.max(0, ...values.filter(Number.isFinite));
  const intervalCount = Math.max(1, intervals);
  const step = niceCeiling(dataMax / intervalCount);
  const count = Math.max(intervalCount, Math.ceil(dataMax / step));
  const max = count * step;
  return {
    max,
    step,
    ticks: Array.from({ length: count + 1 }, (_, index) => index * step),
  };
}

export function formatCurrencyTick(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `$${value.toFixed(decimals)}`;
}
