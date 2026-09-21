import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { auditProducts, formatReport, type AuditReport } from "./audit.js";
import { productSchema } from "./product.js";
import { RULES, RULE_IDS, getRule } from "./rules.js";
import {
  DEFAULT_MAX_PRODUCTS,
  MAX_PRODUCTS_CAP,
  StoreFetchError,
  fetchStoreProducts,
  normalizeDomain,
} from "./shopify.js";
import { VERSION } from "./version.js";

export const RULES_RESOURCE_URI = "rules://catalog";

export interface ServerDeps {
  /** Injected in tests so no request leaves the process. */
  fetch?: typeof fetch;
}

const INSTRUCTIONS =
  "Audits e-commerce product data for Google Shopping and Meta catalog readiness. " +
  "Use audit_store for a live Shopify store (public products.json only), audit_products for product data you already " +
  "have, and explain_rule for what a finding means and how to fix it. Report 'gtin-unknown' as unknown, not missing.";

function reportResult(report: AuditReport): CallToolResult {
  return {
    content: [
      { type: "text", text: formatReport(report) },
      { type: "text", text: JSON.stringify(report, null, 2) },
    ],
    structuredContent: { ...report },
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function ruleCatalog() {
  return RULES.map(({ id, severity, title, rationale, fix }) => ({ id, severity, title, rationale, fix }));
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "catalog-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "audit_store",
    {
      title: "Audit a Shopify store",
      description:
        "Fetches a Shopify store's public /products.json (sequentially, one request per second) and reports which " +
        "products Google Shopping or Meta would reject or show less, with sample URLs and the value affected. " +
        "Storefront data has no barcodes, so GTINs are reported as unknown.",
      inputSchema: {
        domain: z.string().min(1).describe('Store domain, e.g. "shop.example.com" or "my-store.myshopify.com".'),
        maxProducts: z
          .number()
          .int()
          .min(1)
          .max(MAX_PRODUCTS_CAP)
          .optional()
          .describe(`Stop after this many products (default ${DEFAULT_MAX_PRODUCTS}, max ${MAX_PRODUCTS_CAP}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ domain, maxProducts }) => {
      try {
        const fetched = await fetchStoreProducts({
          domain,
          maxProducts,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
        const report = auditProducts(fetched.products, {
          source: "storefront",
          domain: fetched.domain,
          complete: fetched.complete,
          maxProducts: fetched.maxProducts,
        });
        return reportResult(report);
      } catch (error) {
        if (error instanceof StoreFetchError) return errorResult(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "audit_products",
    {
      title: "Audit supplied products",
      description:
        "Runs the same audit on products you supply in Shopify products.json shape (handle, vendor, product_type, " +
        "images, variants[].price / requires_shipping). If variants include a barcode field, GTINs are validated " +
        "with the GS1 check digit.",
      inputSchema: {
        products: z.array(productSchema).min(1).max(MAX_PRODUCTS_CAP),
        domain: z.string().optional().describe("Optional store domain, used only to build sample product URLs."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ products, domain }) => {
      let host: string | undefined;
      try {
        host = domain ? normalizeDomain(domain) : undefined;
      } catch (error) {
        return errorResult((error as Error).message);
      }
      return reportResult(auditProducts(products, { source: "supplied", domain: host, complete: true }));
    },
  );

  server.registerTool(
    "explain_rule",
    {
      title: "Explain an audit rule",
      description: "Returns why a rule matters to Google Shopping / Meta and how to fix products it flags.",
      inputSchema: { ruleId: z.enum(RULE_IDS) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ruleId }) => {
      const rule = getRule(ruleId);
      const text = `${rule.id} (${rule.severity}): ${rule.title}\n\nWhy: ${rule.rationale}\n\nFix: ${rule.fix}`;
      const { id, severity, title, rationale, fix } = rule;
      return { content: [{ type: "text", text }], structuredContent: { id, severity, title, rationale, fix } };
    },
  );

  server.registerResource(
    "rule-catalog",
    RULES_RESOURCE_URI,
    {
      title: "Audit rule catalogue",
      description: "Every rule catalog-mcp checks, with severity, rationale and fix.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ruleCatalog(), null, 2) }],
    }),
  );

  return server;
}
