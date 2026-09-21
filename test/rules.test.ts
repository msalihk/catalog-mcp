import { describe, expect, it } from "vitest";
import { RULES, checkProduct, getRule, type RuleId } from "../src/rules.js";
import { makeProduct, makeVariant } from "./helpers.js";
import type { Product } from "../src/product.js";

const run = (id: RuleId, product: Product) => getRule(id).check(product);

describe("rule catalogue", () => {
  it("has unique ids and complete explanations", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of RULES) {
      expect(rule.rationale.length).toBeGreaterThan(40);
      expect(rule.fix.length).toBeGreaterThan(20);
    }
  });

  it("a complete storefront product only gets the gtin-unknown info finding", () => {
    expect(checkProduct(makeProduct()).map((f) => f.ruleId)).toEqual(["gtin-unknown"]);
  });
});

describe("no-image", () => {
  it("fires for an empty or missing images array", () => {
    expect(run("no-image", makeProduct({ images: [] }))).toHaveLength(1);
    expect(run("no-image", makeProduct({ images: null }))).toHaveLength(1);
  });
  it("passes with one image", () => {
    expect(run("no-image", makeProduct())).toEqual([]);
  });
});

describe("missing-brand", () => {
  it.each([[""], ["   "], [null]])("fires for vendor %j", (vendor) => {
    expect(run("missing-brand", makeProduct({ vendor }))).toHaveLength(1);
  });
  it("passes with a vendor", () => {
    expect(run("missing-brand", makeProduct({ vendor: "Acme" }))).toEqual([]);
  });
});

describe("missing-category", () => {
  it("fires for an empty product_type", () => {
    expect(run("missing-category", makeProduct({ product_type: "" }))).toHaveLength(1);
  });
  it("passes with a product_type", () => {
    expect(run("missing-category", makeProduct())).toEqual([]);
  });
});

describe("GTIN rules", () => {
  it("storefront data (no barcode field) is reported as unknown, never as missing", () => {
    const product = makeProduct();
    expect(run("gtin-unknown", product)).toHaveLength(1);
    expect(run("missing-gtin", product)).toEqual([]);
    expect(run("invalid-gtin", product)).toEqual([]);
  });

  it("checks barcodes when the data includes them", () => {
    const product = makeProduct({
      variants: [
        makeVariant({ barcode: "4006381333931" }),
        makeVariant({ barcode: "" }),
        makeVariant({ barcode: null }),
        makeVariant({ barcode: "4006381333932" }),
      ],
    });
    expect(run("gtin-unknown", product)).toEqual([]);
    expect(run("missing-gtin", product)).toEqual([
      { ruleId: "missing-gtin", message: "2 of 4 variants have no barcode." },
    ]);
    expect(run("invalid-gtin", product)).toEqual([
      {
        ruleId: "invalid-gtin",
        message: 'Invalid barcode: "4006381333932" check digit is 2, expected 1.',
      },
    ]);
  });

  it("treats a variant without the key as missing once any variant carries barcodes", () => {
    const product = makeProduct({
      variants: [makeVariant({ barcode: "036000291452" }), makeVariant()],
    });
    expect(run("missing-gtin", product)).toHaveLength(1);
  });

  it("passes when every barcode is a valid GTIN", () => {
    const product = makeProduct({
      variants: [makeVariant({ barcode: "96385074" }), makeVariant({ barcode: "036000291452" })],
    });
    expect(checkProduct(product)).toEqual([]);
  });
});
