# catalog-mcp

[![CI](https://github.com/msalihk/catalog-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/msalihk/catalog-mcp/actions)

An MCP server that audits an e-commerce product catalog for Google Shopping and Meta catalog readiness. Connect it to an AI assistant and ask *"which products in this store will be rejected or shown less, and why?"* The assistant gets a per-rule breakdown, sample product URLs, and how much catalog value is affected.

It reads a Shopify store's public `products.json`, or product data you pass in directly, and runs a small set of checks. Each check is a pure function over one product.

## Why

Most feed problems are boring and fixable: a missing image, an empty vendor, a product type nobody filled in. What is hard is finding them across hundreds of products and deciding which ones matter. An assistant with this server can do that in a conversation, and it can explain each finding without guessing at rules. It also says what it could not check. Barcodes are not in public storefront data, and the audit says "unknown" rather than "missing".

## Install

Requires Node 22 or newer.

```sh
git clone https://github.com/msalihk/catalog-mcp.git
cd catalog-mcp
npm install        # also builds dist/ via the prepare script
```

Inside the clone, `npx catalog-mcp` starts the server on stdio. You can also run `npm link` to put a `catalog-mcp` command on your PATH.

This package is not published to npm. The unscoped name `catalog-mcp` on the npm registry belongs to an unrelated project, so running `npx catalog-mcp` outside this clone will not run this server.

## Add it to an MCP client

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and most other clients take the same shape. Use the absolute path to your clone:

```json
{
  "mcpServers": {
    "catalog-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/catalog-mcp/dist/index.js"]
    }
  }
}
```

If you ran `npm link`, `"command": "catalog-mcp"` with no args also works.

## Tools

### `audit_store`

| Argument | Type | Notes |
| --- | --- | --- |
| `domain` | string | `shop.example.com`, `https://shop.example.com/` or `my-store.myshopify.com` |
| `maxProducts` | integer, optional | Default 1000, maximum 5000 |

Reads `https://{domain}/products.json?limit=250&page=N` and audits what it gets. The fetcher is deliberately slow:

- one request at a time, at least one second apart, never in parallel;
- a `User-Agent` of `catalog-mcp/<version> (+https://github.com/msalihk/catalog-mcp)`;
- on HTTP 429 it waits for `Retry-After` if the store sends one, otherwise 2s, 4s, 8s…, and gives up after 5 retries;
- it stops at `maxProducts`. If that cut the scan short, the report says the audit is partial and does not extrapolate.

A 404, 401/403, an HTML password page or a JSON body without a `products` array comes back as a tool error that says the store is probably not Shopify, or is blocking access. Only public DNS names are accepted. IP addresses, ports and names like `*.local` are refused.

### `audit_products`

| Argument | Type | Notes |
| --- | --- | --- |
| `products` | array | Products in Shopify `products.json` shape, 1 to 5000 |
| `domain` | string, optional | Only used to build sample URLs |

This runs the same audit on data you already have, for offline use or for other platforms mapped to the Shopify shape. The fields read are `handle`, `vendor`, `product_type`, `images[]`, and `variants[].price`, `variants[].requires_shipping` and `variants[].barcode`. If any variant carries a `barcode` field, the GTIN rules run on that product.

### `explain_rule`

| Argument | Type |
| --- | --- |
| `ruleId` | one of the rule ids below |

Returns why the rule matters and how to fix flagged products.

### Resource `rules://catalog`

The full rule catalogue as JSON: id, severity, title, rationale and fix.

## Rules

| Rule | Severity | Fires when |
| --- | --- | --- |
| `no-image` | blocking | The product has no images. Google and Meta will not list it. |
| `missing-brand` | blocking | `vendor` is empty or whitespace. Shopify channels send vendor as brand. |
| `missing-category` | warning | `product_type` is empty. |
| `gtin-unknown` | info | The data has no `barcode` fields, which is always the case for storefront data. Reported as unknown, not missing. |
| `missing-gtin` | warning | Barcode data is present and at least one variant's barcode is empty. |
| `invalid-gtin` | warning | A barcode is not a valid GTIN-8/12/13/14 (length, digits, or the GS1 mod-10 check digit). |

Products that aren't sellable in a shopping feed are skipped and counted separately. That covers products where every variant is priced 0, and products where every variant has `requires_shipping: false` (gift cards, services, fees). Only an explicit value counts. A price that can't be read is not treated as 0, and a missing `requires_shipping` is not treated as `false`.

## What an audit returns

Each audit result has two text blocks, a readable summary and the same report as JSON, plus `structuredContent` holding the JSON:

- products checked, and not-sellable products skipped (split into zero-price and no-shipping);
- for each rule: products evaluated, products affected, up to 5 sample URLs (`https://{domain}/products/{handle}`), and value at lowest listed price;
- overall: products with at least one blocking or warning finding, and their value at lowest listed price;
- whether the scan was complete.

**Value at lowest listed price** means one unit of each affected product at its lowest variant price above zero. Each product counts once. The figure is never multiplied by stock and never summed across variants. It is in the store's own currency, unconverted. `products.json` doesn't say which currency that is. Affected products with no price above zero add nothing and are counted separately.

## Example

In this conversation the assistant is connected to catalog-mcp. The store is fictional. The tool output is what the server actually returns for `test/fixtures/storefront-products.json`, a six-product fixture in storefront format.

> **User:** Can you check harbor.example for anything that would stop products showing on Google Shopping?

The assistant calls `audit_store` with `{ "domain": "harbor.example" }` and gets:

```text
Catalog audit for harbor.example (public storefront products.json)
Checked 4 products. Skipped 2 not sellable (1 priced 0, 1 not requiring shipping).

Blocking (will not be listed):
- no-image: 1 product, value at lowest listed price 18.50
    https://harbor.example/products/stoneware-mug
- missing-brand: 2 products, value at lowest listed price 38.00
    https://harbor.example/products/enamel-pin
    https://harbor.example/products/heavyweight-tee

Warnings (may be disapproved or shown less):
- missing-category: 1 product, value at lowest listed price 29.00
    https://harbor.example/products/heavyweight-tee

Not determinable from this data:
- gtin-unknown: 4 products. GTINs unknown (the data has no barcodes).

Not checked (the data has no barcodes): missing-gtin, invalid-gtin.

Overall: 3 products with at least one blocking or warning finding, value at lowest listed price 56.50.
Amounts are in the store's own currency, unconverted. Shopify's products.json does not say which currency that is.
Value at lowest listed price = one unit of each affected product at its lowest variant price above zero. Each product counts once; stock levels and variant counts are ignored.
```

> **Assistant:** 3 of the 4 sellable products have a problem. I skipped the gift card and the zero-priced "Shipping Protection" item.
>
> - **Stoneware Mug** has no image, so Google and Meta won't list it at all.
> - **Enamel Pin** and **Heavyweight Tee** have an empty vendor. Shopify sends vendor as the brand, and both channels require one.
> - **Heavyweight Tee** also has no product type. That won't block it, but it makes the product harder to classify and to group in campaigns.
>
> At one unit each at their cheapest variant, that's 56.50 in the store's currency. The tee has 18 variants and counts once, at 29.00.
>
> I can't tell whether your GTINs are set, because Shopify's public product data doesn't include barcodes. If you export your products with barcodes, I can validate them with `audit_products`.

## Development

```sh
npm test            # vitest, fully offline: HTTP is mocked, timers are faked
npm run typecheck   # tsc --noEmit, strict
npm run build       # emits dist/
npm run dev         # run the server from source with tsx
```

The tests cover each rule, GTIN check digits (worked out by hand in the test comments), the sellable filter, the value metric, pagination and 429 backoff against a scripted `fetch`, and an end-to-end run where an SDK `Client` talks to the server over `InMemoryTransport`.

## Design notes

- **Rules are data plus a pure function.** Each rule has an id, severity, rationale, fix and `check(product) → findings`. The audit, `explain_rule` and `rules://catalog` all read the same list, so there is one place to add a rule.
- **Unknown is reported as unknown.** Storefront data has no barcodes, so the GTIN rules report "unknown" or "not checked" instead of a false "missing". The same idea runs through the sellable filter and pricing. A missing field is never read as a negative.
- **One number, clearly defined.** The value metric is simple on purpose: one unit, lowest positive price, once per product. It gives a sense of scale. It is not a revenue estimate.
- **Polite by construction.** The fetcher has no concurrency option. Spacing, backoff and the product cap live in one function, and tests check them against a fake clock.
- **Money is summed in hundredths** so ten `0.10` prices add up to exactly `1.00` (a test checks this).
- `fetch` is injected into the server, which is how the tests stay offline.

## Limitations

- Only Shopify storefronts can be fetched. Stores that disable `products.json`, sit behind a password page or bot protection, or rate-limit hard will fail with an explanatory error.
- Storefront data has no barcodes, inventory, currency, Shopify's standard product category or Google-specific metafields. The audit only checks what the data contains.
- The rules are a small, high-signal subset of Google's and Meta's requirements. They do not cover titles, descriptions, image quality, landing pages, shipping or tax settings, GTIN prefix restrictions, or policy issues.
- Severity reflects typical channel behaviour. Google and Meta change their requirements, and the final word is Merchant Center's or Commerce Manager's diagnostics.
- Audits of large stores are slow on purpose. 5000 products means at least 20 requests at one per second.

## Related

- [Feedwatch](https://feedwatch.co), a Shopify app by the same author, runs the same kind of checks continuously and applies fixes inside Shopify admin.
- [What 3,170 Shopify catalogs look like from the outside](https://feedwatch.co/benchmarks): how often these findings turn up in the public catalogs of stores that run Google Ads, with the method.
- [Guides to Merchant Center errors on Shopify](https://feedwatch.co/guides): one page per error, sourced from Google's and Shopify's help pages.

## License

MIT © 2026 Salih Küçükkayış
