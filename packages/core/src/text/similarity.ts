// How close two texts are in wording (ADR-0030): the cosine similarity of
// their character trigrams. Every run of characters that are neither letters
// nor digits becomes one space, and each text is padded with a space, so word
// starts and ends count. Trigrams follow a stem through its suffixes, which
// matters in Turkish. It needs no model and gives the same number every time.
// The caller folds both texts first, with the case's language pack.

/** The trigram counts of a folded text; empty when it has no letter or digit. */
function trigrams(text: string): Map<string, number> {
  const words = text.replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const counts = new Map<string, number>();
  // Without a letter or a digit, two spaces: no trigram.
  const characters = Array.from(` ${words} `);
  for (let at = 0; at + 3 <= characters.length; at += 1) {
    const gram = characters.slice(at, at + 3).join('');
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function norm(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const value of counts.values()) sum += value * value;
  return Math.sqrt(sum);
}

/** From 0, nothing shared, to 1, the same wording; 0 when either text has no letter or digit. */
export function textSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  const lengths = norm(left) * norm(right);
  if (lengths === 0) return 0;
  let dot = 0;
  for (const [gram, value] of left) dot += value * (right.get(gram) ?? 0);
  return dot / lengths;
}
