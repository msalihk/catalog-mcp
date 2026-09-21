import { z } from "zod";

/**
 * The subset of Shopify's public `products.json` shape that the rules read.
 * Objects are loose so real storefront payloads (and caller data mapped from
 * other platforms) pass through without every field being declared.
 */
export const variantSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  title: z.string().nullish(),
  price: z.union([z.string(), z.number()]).nullish(),
  requires_shipping: z.boolean().nullish(),
  // Not present in storefront products.json. Only caller-supplied data has it.
  barcode: z.string().nullish(),
});

export const imageSchema = z.looseObject({
  src: z.string().optional(),
});

export const productSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  title: z.string().nullish(),
  handle: z.string().min(1),
  vendor: z.string().nullish(),
  product_type: z.string().nullish(),
  images: z.array(imageSchema).nullish(),
  variants: z.array(variantSchema).nullish(),
});

export type Variant = z.infer<typeof variantSchema>;
export type Product = z.infer<typeof productSchema>;

/** Parses a price as Shopify sends it ("19.99") or as a number. Unknown → null. */
export function parsePrice(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Lowest variant price above zero, or null when no variant has one. */
export function lowestListedPrice(product: Product): number | null {
  let lowest: number | null = null;
  for (const variant of product.variants ?? []) {
    const price = parsePrice(variant.price);
    if (price !== null && price > 0 && (lowest === null || price < lowest)) lowest = price;
  }
  return lowest;
}

export type Sellability =
  | { sellable: true }
  | { sellable: false; reason: "zero-price" | "no-shipping" };

/**
 * Gift cards, services and fees don't belong in a shopping feed, so they are
 * skipped rather than reported. Only an explicit signal counts: a price we
 * cannot read is not zero, and a missing `requires_shipping` is not false.
 */
export function sellability(product: Product): Sellability {
  const variants = product.variants ?? [];
  if (variants.length === 0) return { sellable: true };
  if (variants.every((v) => parsePrice(v.price) === 0)) {
    return { sellable: false, reason: "zero-price" };
  }
  if (variants.every((v) => v.requires_shipping === false)) {
    return { sellable: false, reason: "no-shipping" };
  }
  return { sellable: true };
}

/** True when the data carries a `barcode` field at all (storefront data never does). */
export function hasBarcodeData(product: Product): boolean {
  return (product.variants ?? []).some((v) => Object.hasOwn(v, "barcode"));
}
