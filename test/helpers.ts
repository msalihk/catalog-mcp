import type { Product, Variant } from "../src/product.js";

let nextId = 1;

/** A product that passes every rule on storefront data (apart from gtin-unknown). */
export function makeProduct(overrides: Partial<Product> = {}): Product {
  const id = nextId++;
  return {
    id,
    title: `Product ${id}`,
    handle: `product-${id}`,
    vendor: "Acme",
    product_type: "Shirts",
    images: [{ src: `https://cdn.example.com/${id}.jpg` }],
    variants: [makeVariant()],
    ...overrides,
  };
}

export function makeVariant(overrides: Partial<Variant> = {}): Variant {
  return { id: nextId++, title: "Default Title", price: "20.00", requires_shipping: true, ...overrides };
}
