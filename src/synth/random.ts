/** Small seeded PRNG so a given seed always produces the same workload. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Positive integer scattered around `mean`, log-normally with the given spread. */
  around(mean: number, spread?: number): number;
}

/** mulberry32: tiny, fast and good enough for test data. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    // Box-Muller; 1 - next() keeps the log argument away from 0
    const u = 1 - next();
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    around: (mean, spread = 0.3) => Math.max(1, Math.round(mean * Math.exp(normal() * spread))),
  };
}

/** Derive an independent seed for a named stream, so adding one stream never reshuffles another. */
export function subSeed(seed: number, name: string): number {
  let h = (seed >>> 0) ^ 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
