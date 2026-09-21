import { lowestListedPrice, sellability, type Product } from "./product.js";
import { RULES, checkProduct, type RuleId, type Severity } from "./rules.js";

export const SAMPLE_LIMIT = 5;

export const CURRENCY_NOTE =
  "Amounts are in the store's own currency, unconverted. Shopify's products.json does not say which currency that is.";

export const VALUE_NOTE =
  "Value at lowest listed price = one unit of each affected product at its lowest variant price above zero. " +
  "Each product counts once; stock levels and variant counts are ignored.";

export interface AuditContext {
  source: "storefront" | "supplied";
  /** Used to build sample product URLs. */
  domain?: string | undefined;
  /** False when the scan stopped at maxProducts and the store may have more. */
  complete: boolean;
  maxProducts?: number | undefined;
}

export interface RuleSummary {
  ruleId: RuleId;
  severity: Severity;
  title: string;
  /** Products the rule could evaluate; 0 means the data never had what it needs. */
  productsEvaluated: number;
  productsAffected: number;
  valueAtLowestPrice: number;
  /** Affected products with no variant priced above zero, so they add nothing to the value. */
  affectedWithoutPrice: number;
  sampleUrls: string[];
}

export interface AuditReport {
  source: AuditContext["source"];
  domain: string | null;
  complete: boolean;
  productsChecked: number;
  notSellableSkipped: { total: number; zeroPrice: number; noShipping: number };
  rules: RuleSummary[];
  overall: {
    /** Products with at least one blocking or warning finding. Info findings are excluded. */
    productsWithIssues: number;
    valueAtLowestPrice: number;
    affectedWithoutPrice: number;
  };
  notes: string[];
}

function productUrl(handle: string, domain: string | undefined): string {
  const path = `/products/${encodeURIComponent(handle)}`;
  return domain ? `https://${domain}${path}` : path;
}

/** Sum money in hundredths so repeated float addition doesn't drift. */
const toCents = (amount: number): number => Math.round(amount * 100);
const fromCents = (cents: number): number => cents / 100;

export function auditProducts(products: readonly Product[], ctx: AuditContext): AuditReport {
  const skipped = { total: 0, zeroPrice: 0, noShipping: 0 };
  const perRule = new Map<RuleId, { evaluated: number; count: number; cents: number; noPrice: number; samples: string[] }>(
    RULES.map((r) => [r.id, { evaluated: 0, count: 0, cents: 0, noPrice: 0, samples: [] }]),
  );
  const severityOf = new Map(RULES.map((r) => [r.id, r.severity]));
  const overall = { count: 0, cents: 0, noPrice: 0 };
  let checked = 0;

  for (const product of products) {
    const s = sellability(product);
    if (!s.sellable) {
      skipped.total++;
      if (s.reason === "zero-price") skipped.zeroPrice++;
      else skipped.noShipping++;
      continue;
    }
    checked++;

    const price = lowestListedPrice(product);
    for (const rule of RULES) {
      if (rule.appliesTo?.(product) ?? true) perRule.get(rule.id)!.evaluated++;
    }
    // A rule reports at most one finding per product, but guard anyway so the
    // "each product counts once" guarantee doesn't depend on that.
    const ruleIds = new Set(checkProduct(product).map((f) => f.ruleId));

    for (const ruleId of ruleIds) {
      const acc = perRule.get(ruleId)!;
      acc.count++;
      if (price === null) acc.noPrice++;
      else acc.cents += toCents(price);
      if (acc.samples.length < SAMPLE_LIMIT) acc.samples.push(productUrl(product.handle, ctx.domain));
    }

    if ([...ruleIds].some((id) => severityOf.get(id) !== "info")) {
      overall.count++;
      if (price === null) overall.noPrice++;
      else overall.cents += toCents(price);
    }
  }

  const notes = [CURRENCY_NOTE, VALUE_NOTE];
  if (!ctx.complete) {
    notes.unshift(
      `Partial audit: the scan stopped at maxProducts (${ctx.maxProducts ?? "limit"}) and the store may have more ` +
        "products. Figures cover only the products fetched and are not extrapolated.",
    );
  }

  return {
    source: ctx.source,
    domain: ctx.domain ?? null,
    complete: ctx.complete,
    productsChecked: checked,
    notSellableSkipped: skipped,
    rules: RULES.map((rule) => {
      const acc = perRule.get(rule.id)!;
      return {
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
        productsEvaluated: acc.evaluated,
        productsAffected: acc.count,
        valueAtLowestPrice: fromCents(acc.cents),
        affectedWithoutPrice: acc.noPrice,
        sampleUrls: acc.samples,
      };
    }),
    overall: {
      productsWithIssues: overall.count,
      valueAtLowestPrice: fromCents(overall.cents),
      affectedWithoutPrice: overall.noPrice,
    },
    notes,
  };
}

const SECTION_HEADINGS: Record<Severity, string> = {
  blocking: "Blocking (will not be listed)",
  warning: "Warnings (may be disapproved or shown less)",
  info: "Not determinable from this data",
};

const money = (n: number): string => n.toFixed(2);
const products = (n: number): string => `${n} product${n === 1 ? "" : "s"}`;

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  const target = report.domain ?? "supplied products";
  const source = report.source === "storefront" ? "public storefront products.json" : "caller-supplied data";
  lines.push(`Catalog audit for ${target} (${source})`);

  const s = report.notSellableSkipped;
  lines.push(
    `Checked ${products(report.productsChecked)}. Skipped ${s.total} not sellable ` +
      `(${s.zeroPrice} priced 0, ${s.noShipping} not requiring shipping).`,
  );
  if (!report.complete) lines.push(report.notes[0]!);

  for (const severity of ["blocking", "warning", "info"] as const) {
    const hits = report.rules.filter((r) => r.severity === severity && r.productsAffected > 0);
    if (hits.length === 0) continue;
    lines.push("", `${SECTION_HEADINGS[severity]}:`);
    for (const r of hits) {
      if (severity === "info") {
        lines.push(`- ${r.ruleId}: ${products(r.productsAffected)}. ${r.title}.`);
        continue;
      }
      const noPrice = r.affectedWithoutPrice > 0 ? ` (${r.affectedWithoutPrice} without a price above 0)` : "";
      lines.push(
        `- ${r.ruleId}: ${products(r.productsAffected)}, value at lowest listed price ${money(r.valueAtLowestPrice)}${noPrice}`,
      );
      for (const url of r.sampleUrls) lines.push(`    ${url}`);
    }
  }

  const clean = report.rules.filter((r) => r.productsEvaluated > 0 && r.productsAffected === 0).map((r) => r.ruleId);
  const unchecked = report.rules.filter((r) => r.productsEvaluated === 0).map((r) => r.ruleId);
  if (report.productsChecked > 0 && (clean.length > 0 || unchecked.length > 0)) lines.push("");
  if (report.productsChecked > 0 && clean.length > 0) lines.push(`No products affected: ${clean.join(", ")}.`);
  if (report.productsChecked > 0 && unchecked.length > 0) lines.push(`Not checked (the data has no barcodes): ${unchecked.join(", ")}.`);

  lines.push(
    "",
    `Overall: ${products(report.overall.productsWithIssues)} with at least one blocking or warning finding, ` +
      `value at lowest listed price ${money(report.overall.valueAtLowestPrice)}.`,
    ...report.notes.slice(report.complete ? 0 : 1),
  );
  return lines.join("\n");
}
