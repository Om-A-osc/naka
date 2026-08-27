export interface CatalogVariantJson {
  id: string;
  title: string;
  sku: string;
  price_paise: number;
  stock_qty: number;
  aliases?: string[];
  attributes?: Record<string, unknown>;
}

export interface CatalogProductJson {
  id: string;
  title: string;
  description: string;
  category: string;
  variants: CatalogVariantJson[];
}

export interface CatalogFile {
  merchant: { id: string; name: string; display_name: string; currency: string };
  products: CatalogProductJson[];
  frequently_bought_with: Array<{ variant_id: string; addon_variant_id: string; weight?: number }>;
  coupons: Array<{ code: string; pct: number; max_paise: number; min_order_paise: number }>;
}

export interface SearchResult {
  product_id: string;
  variant_id: string;
  title: string;
  variant_title: string;
  price_paise: number;
  /** The same price already rendered for a human. */
  price_display: string;
  category: string;
  availability: "in_stock" | "low_stock" | "out_of_stock";
  attributes: Record<string, unknown>;
  description: string;
  match_reason: "alias" | "fts" | "filter";
}
