import { describe, expect, it } from "vitest";
import { lowestListedPrice, parsePrice, sellability } from "../src/product.js";
import { makeProduct, makeVariant } from "./helpers.js";

describe("parsePrice", () => {
  it("reads Shopify string prices and numbers", () => {
    expect(parsePrice("19.99")).toBe(19.99);
    expect(parsePrice(5)).toBe(5);
    expect(parsePrice("0.00")).toBe(0);
  });
  it("returns null for anything it cannot read", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("free")).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
    expect(parsePrice(-1)).toBeNull();
  });
});

describe("sellability", () => {
  it("skips products where every variant is priced 0", () => {
    const product = makeProduct({ variants: [makeVariant({ price: "0.00" }), makeVariant({ price: 0 })] });
    expect(sellability(product)).toEqual({ sellable: false, reason: "zero-price" });
  });

  it("keeps products where only some variants are priced 0", () => {
    const product = makeProduct({ variants: [makeVariant({ price: "0.00" }), makeVariant({ price: "9.00" })] });
    expect(sellability(product)).toEqual({ sellable: true });
  });

  it("does not treat an unreadable price as zero", () => {
    const product = makeProduct({ variants: [makeVariant({ price: "0" }), makeVariant({ price: null })] });
    expect(sellability(product)).toEqual({ sellable: true });
  });

  it("skips products where no variant requires shipping (gift cards, services)", () => {
    const product = makeProduct({
      variants: [makeVariant({ requires_shipping: false }), makeVariant({ requires_shipping: false })],
    });
    expect(sellability(product)).toEqual({ sellable: false, reason: "no-shipping" });
  });

  it("does not treat a missing requires_shipping as false", () => {
    const product = makeProduct({
      variants: [makeVariant({ requires_shipping: false }), { price: "10.00" }],
    });
    expect(sellability(product)).toEqual({ sellable: true });
  });

  it("keeps products with no variant data", () => {
    expect(sellability(makeProduct({ variants: [] }))).toEqual({ sellable: true });
  });
});

describe("lowestListedPrice", () => {
  it("ignores zero and unreadable prices", () => {
    const product = makeProduct({
      variants: [makeVariant({ price: "0.00" }), makeVariant({ price: "12.50" }), makeVariant({ price: "x" }), makeVariant({ price: "8.25" })],
    });
    expect(lowestListedPrice(product)).toBe(8.25);
  });
  it("is null when nothing is priced above zero", () => {
    expect(lowestListedPrice(makeProduct({ variants: [makeVariant({ price: "0" })] }))).toBeNull();
  });
});
