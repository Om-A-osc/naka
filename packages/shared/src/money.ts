/** Money is always an integer number of paise. */

export type Paise = number & { readonly __brand: "Paise" };

export function paise(n: number): Paise {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid paise amount: ${n} (must be a non-negative integer)`);
  }
  return n as Paise;
}

export function addPaise(...amounts: Paise[]): Paise {
  return paise(amounts.reduce((a, b) => a + b, 0));
}

export function subPaise(a: Paise, b: Paise): Paise {
  const r = a - b;
  if (r < 0) throw new Error(`subPaise underflow: ${a} - ${b}`);
  return paise(r);
}

export function mulQty(unit: Paise, qty: number): Paise {
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`invalid quantity: ${qty}`);
  return paise(unit * qty);
}

/** Percentage discount, floored to the paise, capped at maxPaise if given. */
export function pctDiscount(base: Paise, pct: number, maxPaise?: Paise): Paise {
  const raw = Math.floor((base * pct) / 100);
  return paise(maxPaise !== undefined ? Math.min(raw, maxPaise) : raw);
}

export function formatInr(p: Paise): string {
  const rupees = Math.floor(p / 100);
  const paisePart = p % 100;
  const withCommas = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return paisePart === 0 ? `₹${withCommas}` : `₹${withCommas}.${String(paisePart).padStart(2, "0")}`;
}
