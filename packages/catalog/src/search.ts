import type { Db } from "@naka/db";
import type { SearchResult } from "./types.js";
import { formatInr } from "@naka/shared";

export interface SearchArgs {
  query: string;
  category?: string;
  max_price_paise?: number;
  in_stock_only?: boolean;
  limit?: number;
  /** Restrict results to one merchant; a server hosting several catalogs always sets this. */
  merchant_id?: string;
}

function availability(stock: number, reserved: number): "in_stock" | "low_stock" | "out_of_stock" {
  const net = stock - reserved;
  if (net <= 0) return "out_of_stock";
  if (net <= 3) return "low_stock";
  return "in_stock";
}

function rowToResult(row: any, reason: SearchResult["match_reason"]): SearchResult {
  return {
    product_id: row.product_id,
    variant_id: row.variant_id,
    title: row.product_title,
    variant_title: row.variant_title,
    price_paise: row.price_paise,
    price_display: formatInr(row.price_paise),
    category: row.category,
    availability: availability(row.stock_qty, row.reserved_qty),
    attributes: JSON.parse(row.attributes ?? "{}"),
    description: row.description,
    match_reason: reason,
  };
}

const BASE_SELECT = `
  SELECT v.id AS variant_id, v.title AS variant_title, v.price_paise, v.stock_qty, v.reserved_qty, v.attributes,
         p.id AS product_id, p.title AS product_title, p.description, p.category, p.merchant_id
  FROM variants v JOIN products p ON p.id = v.product_id
  WHERE v.active = 1`;

/** Deterministic retrieval: exact Hinglish/English alias match first, then FTS5 full-text match, then plain filters, never an LLM in the loop. */
export function searchCatalog(db: Db, args: SearchArgs): SearchResult[] {
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 20);
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  const filterOk = (row: any) => {
    if (args.merchant_id && row.merchant_id !== args.merchant_id) return false;
    if (args.category && row.category !== args.category) return false;
    if (args.max_price_paise !== undefined && row.price_paise > args.max_price_paise) return false;
    if (args.in_stock_only !== false && row.stock_qty - row.reserved_qty <= 0) return false;
    return true;
  };

  // 1) alias match, ranked by how many aliases the query hit.
  const words = args.query.toLowerCase().trim();
  if (words) {
    const hits = new Map<string, { n: number; weight: number }>();
    for (const h of db
      .prepare(
        `SELECT variant_id, COUNT(*) AS n, SUM(LENGTH(alias)) AS weight FROM variant_aliases WHERE alias = ? OR ? LIKE '%' || alias || '%' GROUP BY variant_id`
      )
      .all(words, words) as Array<{ variant_id: string; n: number; weight: number }>) {
      hits.set(h.variant_id, { n: h.n, weight: h.weight });
    }
    const aliasRows = (db
      .prepare(
        `${BASE_SELECT} AND v.id IN (SELECT variant_id FROM variant_aliases WHERE alias = ? OR ? LIKE '%' || alias || '%')`
      )
      .all(words, words) as any[]).sort((a, b) => {
      const ha = hits.get(a.variant_id) ?? { n: 0, weight: 0 };
      const hb = hits.get(b.variant_id) ?? { n: 0, weight: 0 };
      return hb.n - ha.n || hb.weight - ha.weight || a.price_paise - b.price_paise;
    });
    for (const row of aliasRows) {
      if (!filterOk(row) || seen.has(row.variant_id)) continue;
      seen.add(row.variant_id);
      results.push(rowToResult(row, "alias"));
    }
  }

  // 2) FTS5 match.
  if (results.length < limit && words) {
    try {
      const ftsQuery = words
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `${w.replace(/["]/g, "")}*`)
        .join(" OR ");
      if (ftsQuery) {
        const ftsRows = db
          .prepare(
            `${BASE_SELECT} AND v.id IN (
               SELECT variant_id FROM catalog_fts WHERE catalog_fts MATCH ? ORDER BY rank
             )`
          )
          .all(ftsQuery) as any[];
        for (const row of ftsRows) {
          if (!filterOk(row) || seen.has(row.variant_id)) continue;
          seen.add(row.variant_id);
          results.push(rowToResult(row, "fts"));
          if (results.length >= limit) break;
        }
      }
    } catch {
      // malformed FTS query from free text, fall through to plain filters
    }
  }

  // 3) plain filters (category/price/stock only, e.g. empty query = "show me coffee")
  if (results.length < limit) {
    const filterRows = db.prepare(`${BASE_SELECT} ORDER BY price_paise ASC`).all() as any[];
    for (const row of filterRows) {
      if (!filterOk(row) || seen.has(row.variant_id)) continue;
      seen.add(row.variant_id);
      results.push(rowToResult(row, "filter"));
      if (results.length >= limit) break;
    }
  }

  return results.slice(0, limit);
}
