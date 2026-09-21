import { checkGtin } from "./gtin.js";
import { hasBarcodeData, type Product } from "./product.js";

/**
 * blocking: the channel will not list the product.
 * warning:  the product can be listed but is likely disapproved for some
 *           placements or shown less.
 * info:     something the audit could not determine from the data it has.
 */
export type Severity = "blocking" | "warning" | "info";

export interface Finding {
  ruleId: RuleId;
  message: string;
}

export interface Rule {
  id: RuleId;
  severity: Severity;
  title: string;
  rationale: string;
  fix: string;
  check(product: Product): Finding[];
}

export const RULE_IDS = [
  "no-image",
  "missing-brand",
  "missing-category",
  "gtin-unknown",
  "missing-gtin",
  "invalid-gtin",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

const isBlank = (value: string | null | undefined): boolean => !value || value.trim() === "";

function finding(ruleId: RuleId, message: string): Finding[] {
  return [{ ruleId, message }];
}

export const RULES: readonly Rule[] = [
  {
    id: "no-image",
    severity: "blocking",
    title: "Product has no image",
    rationale:
      "Google Merchant Center requires an image link for every item and Meta catalogs require an image URL. " +
      "A product without any image cannot be listed on either channel.",
    fix:
      "Add at least one image of the product itself in Shopify admin. Avoid logos, placeholders and " +
      "images with promotional overlays, which Google also rejects.",
    check: (p) =>
      (p.images ?? []).length === 0 ? finding("no-image", "No images on the product.") : [],
  },
  {
    id: "missing-brand",
    severity: "blocking",
    title: "Brand (vendor) is empty",
    rationale:
      "Shopify's sales channels send the product's vendor as the brand. Google requires a brand for new products " +
      "(media such as books and films excepted) and Meta lists brand as a required catalog field, so an empty " +
      "vendor leads to disapproval.",
    fix:
      "Set Vendor to the manufacturer's brand. For products you make yourself, use your own store brand consistently.",
    check: (p) => (isBlank(p.vendor) ? finding("missing-brand", "Vendor is empty.") : []),
  },
  {
    id: "missing-category",
    severity: "warning",
    title: "Product type is empty",
    rationale:
      "Product type is sent as Google's product_type attribute. It is not required, but Google uses it to understand " +
      "and group products, and it is the usual way to split campaigns. Note that the public products.json does not " +
      "include Shopify's standard product category, so a product may have a category set even when this fires.",
    fix: "Fill in Product type in Shopify admin with your own category path, e.g. \"Apparel > Shirts\".",
    check: (p) =>
      isBlank(p.product_type) ? finding("missing-category", "Product type is empty.") : [],
  },
  {
    id: "gtin-unknown",
    severity: "info",
    title: "GTIN status unknown",
    rationale:
      "Shopify's public products.json does not include variant barcodes, so an audit of storefront data cannot tell " +
      "whether GTINs are set or valid. This is not a finding that barcodes are missing.",
    fix:
      "Check the Barcode field on each variant in Shopify admin, or export products with barcodes and pass them to " +
      "audit_products, which validates them.",
    check: (p) =>
      hasBarcodeData(p)
        ? []
        : finding("gtin-unknown", "Barcodes are not included in this data, so GTINs could not be checked."),
  },
  {
    id: "missing-gtin",
    severity: "warning",
    title: "Variant has no GTIN",
    rationale:
      "Google asks for a GTIN on every product that has one assigned by its manufacturer. Branded products without " +
      "a GTIN can be disapproved or shown less. Products that genuinely have no GTIN (custom, handmade, vintage) " +
      "should be marked identifier_exists = no instead.",
    fix:
      "Enter the manufacturer's UPC/EAN in each variant's Barcode field. If the product has no GTIN, leave it empty " +
      "and set identifier_exists to no in your feed app.",
    check: (p) => {
      if (!hasBarcodeData(p)) return [];
      const variants = p.variants ?? [];
      const missing = variants.filter((v) => isBlank(v.barcode)).length;
      return missing === 0
        ? []
        : finding("missing-gtin", `${missing} of ${variants.length} variants have no barcode.`);
    },
  },
  {
    id: "invalid-gtin",
    severity: "warning",
    title: "Variant GTIN is invalid",
    rationale:
      "Google validates GTIN length and the GS1 check digit and disapproves items whose GTIN fails either check.",
    fix:
      "Copy the barcode from the product packaging or the manufacturer. Internal SKUs do not belong in the Barcode field.",
    check: (p) => {
      if (!hasBarcodeData(p)) return [];
      const problems: string[] = [];
      for (const v of p.variants ?? []) {
        if (isBlank(v.barcode)) continue;
        const result = checkGtin(v.barcode as string);
        if (!result.valid) problems.push(`"${v.barcode}" ${result.reason}`);
      }
      return problems.length === 0
        ? []
        : finding("invalid-gtin", `Invalid barcode${problems.length > 1 ? "s" : ""}: ${problems.join("; ")}.`);
    },
  },
];

export function getRule(id: RuleId): Rule {
  const rule = RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`Unknown rule: ${id}`);
  return rule;
}

export function checkProduct(product: Product): Finding[] {
  return RULES.flatMap((rule) => rule.check(product));
}
