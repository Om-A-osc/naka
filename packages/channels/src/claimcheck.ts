/** A lightweight output guard: every rupee figure the model is about to say out loud must already appear somewhere in this turn's tool results. */
export function claimCheck(text: string, context: unknown[]): { ok: boolean; unmatched: number[] } {
  const figures = extractRupeeFiguresAsPaise(text);
  if (figures.length === 0) return { ok: true, unmatched: [] };
  const haystack = JSON.stringify(context);
  const unmatched = figures.filter((paise) => !haystack.includes(String(paise)));
  return { ok: unmatched.length === 0, unmatched };
}

function extractRupeeFiguresAsPaise(text: string): number[] {
  const matches = text.match(/(?:₹|Rs\.?\s?)\s?[\d,]+(?:\.\d{1,2})?/gi) ?? [];
  return matches
    .map((m) => m.replace(/[₹]/g, "").replace(/rs\.?/i, "").trim())
    .map((numStr) => Math.round(parseFloat(numStr.replace(/,/g, "")) * 100))
    .filter((n) => Number.isFinite(n) && n > 0);
}
