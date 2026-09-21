import { describe, expect, it } from "vitest";
import { auditProducts, formatReport, type AuditReport } from "../src/audit.js";
import { makeProduct, makeVariant } from "./helpers.js";

const storefront = { source: "storefront" as const, domain: "shop.example.com", complete: true };
const rule = (report: AuditReport, id: string) => report.rules.find((r) => r.ruleId === id)!;

describe("auditProducts", () => {
  it("counts a product with 18 variants once, at its lowest price above zero", () => {
    const variants = Array.from({ length: 18 }, (_, i) => makeVariant({ price: (30 + i).toFixed(2) }));
    variants[7] = makeVariant({ price: "0.00" }); // a free variant must not become the "lowest" price
    variants[11] = makeVariant({ price: "24.90" });
    const product = makeProduct({ handle: "big-tee", vendor: "", variants });

    const report = auditProducts([product], storefront);

    expect(rule(report, "missing-brand")).toMatchObject({
      productsAffected: 1,
      valueAtLowestPrice: 24.9,
      sampleUrls: ["https://shop.example.com/products/big-tee"],
    });
    expect(report.overall).toEqual({ productsWithIssues: 1, valueAtLowestPrice: 24.9, affectedWithoutPrice: 0 });
  });

  it("counts a product once overall even when several rules fire", () => {
    const product = makeProduct({ vendor: "", images: [], product_type: "", variants: [makeVariant({ price: "10.00" })] });
    const report = auditProducts([product], storefront);
    expect(rule(report, "no-image").productsAffected).toBe(1);
    expect(rule(report, "missing-brand").productsAffected).toBe(1);
    expect(rule(report, "missing-category").productsAffected).toBe(1);
    expect(report.overall).toMatchObject({ productsWithIssues: 1, valueAtLowestPrice: 10 });
  });

  it("sums values without float drift", () => {
    const products = Array.from({ length: 10 }, () =>
      makeProduct({ images: [], variants: [makeVariant({ price: "0.10" })] }),
    );
    expect(rule(auditProducts(products, storefront), "no-image").valueAtLowestPrice).toBe(1);
  });

  it("skips not-sellable products and counts them separately", () => {
    const report = auditProducts(
      [
        makeProduct({ images: [], variants: [makeVariant({ price: "0.00" })] }),
        makeProduct({ images: [], variants: [makeVariant({ requires_shipping: false, price: "25.00" })] }),
        makeProduct({ images: [] }),
      ],
      storefront,
    );
    expect(report.productsChecked).toBe(1);
    expect(report.notSellableSkipped).toEqual({ total: 2, zeroPrice: 1, noShipping: 1 });
    expect(rule(report, "no-image").productsAffected).toBe(1);
  });

  it("keeps at most five sample URLs per rule", () => {
    const products = Array.from({ length: 8 }, (_, i) => makeProduct({ handle: `p-${i}`, product_type: "" }));
    const r = rule(auditProducts(products, storefront), "missing-category");
    expect(r.productsAffected).toBe(8);
    expect(r.sampleUrls).toHaveLength(5);
    expect(r.sampleUrls[0]).toBe("https://shop.example.com/products/p-0");
  });

  it("excludes info-only findings from the overall figure", () => {
    const report = auditProducts([makeProduct(), makeProduct()], storefront);
    expect(rule(report, "gtin-unknown").productsAffected).toBe(2);
    expect(report.overall.productsWithIssues).toBe(0);
  });

  it("reports affected products that have no usable price", () => {
    const report = auditProducts([makeProduct({ vendor: "", variants: [makeVariant({ price: null })] })], storefront);
    expect(rule(report, "missing-brand")).toMatchObject({ productsAffected: 1, valueAtLowestPrice: 0, affectedWithoutPrice: 1 });
  });

  it("uses relative URLs when no domain is known", () => {
    const report = auditProducts([makeProduct({ handle: "mug", images: [] })], { source: "supplied", complete: true });
    expect(rule(report, "no-image").sampleUrls).toEqual(["/products/mug"]);
  });
});

describe("formatReport", () => {
  it("states currency and the value definition", () => {
    const text = formatReport(auditProducts([makeProduct({ images: [] })], storefront));
    expect(text).toContain("store's own currency, unconverted");
    expect(text).toContain("Each product counts once");
    expect(text).toContain("no-image: 1 product, value at lowest listed price 20.00");
    expect(text).not.toContain("Partial audit");
  });

  it("flags a partial audit without extrapolating", () => {
    const report = auditProducts([makeProduct()], { ...storefront, complete: false, maxProducts: 1 });
    const text = formatReport(report);
    expect(text).toContain("Partial audit: the scan stopped at maxProducts (1)");
    expect(text).toContain("not extrapolated");
    expect(text.match(/Partial audit/g)).toHaveLength(1);
  });
});
