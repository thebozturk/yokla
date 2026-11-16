// A fraction drawn from a seed: the same seed gives the same fraction on any
// machine, so what is drawn from it repeats from run to run. Fault jitter
// (ADR-0017) and typos (ADR-0045) draw from it. Pure.

/** A number in [0, 1), the same for the same seed. */
export function seededFraction(seed: string): number {
  // FNV-1a over the seed's UTF-16 code units.
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  // One step of mulberry32 turns the hash into a uniform fraction.
  let t = (hash + 0x6d_2b_79_f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}

/** An integer in [0, count), the same for the same seed. */
export function seededIndex(seed: string, count: number): number {
  return Math.min(count - 1, Math.floor(seededFraction(seed) * count));
}
