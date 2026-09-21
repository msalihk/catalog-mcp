import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditReport } from "../src/audit.js";
import { RULES_RESOURCE_URI, createServer, type ServerDeps } from "../src/server.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/storefront-products.json", import.meta.url), "utf8"),
) as { products: Array<Record<string, unknown>> };

let client: Client | undefined;

async function connect(deps: ServerDeps = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  client = new Client({ name: "catalog-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await c.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (result: CallToolResult, index = 0): string => {
  const block = result.content[index];
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
};

const rule = (report: AuditReport, id: string) => report.rules.find((r) => r.ruleId === id)!;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("MCP server over an in-memory transport", () => {
  it("lists the three tools and the rule catalogue resource", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["audit_products", "audit_store", "explain_rule"]);
    const auditStore = tools.find((t) => t.name === "audit_store")!;
    expect(auditStore.inputSchema.required).toEqual(["domain"]);
    expect(auditStore.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });

    const { resources } = await c.listResources();
    expect(resources).toEqual([expect.objectContaining({ uri: RULES_RESOURCE_URI, mimeType: "application/json" })]);
    const { contents } = await c.readResource({ uri: RULES_RESOURCE_URI });
    const catalogue = JSON.parse((contents[0] as { text: string }).text) as Array<{ id: string }>;
    expect(catalogue.map((r) => r.id)).toContain("gtin-unknown");
  });

  it("audit_products returns a readable summary and matching structured JSON", async () => {
    const c = await connect();
    const result = await call(c, "audit_products", { products: fixture.products, domain: "harbor.example" });

    expect(result.isError).toBeFalsy();
    const report = result.structuredContent as unknown as AuditReport;
    expect(JSON.parse(textOf(result, 1))).toEqual(report);

    expect(report.productsChecked).toBe(4);
    expect(report.notSellableSkipped).toEqual({ total: 2, zeroPrice: 1, noShipping: 1 });
    expect(rule(report, "no-image")).toMatchObject({
      productsAffected: 1,
      valueAtLowestPrice: 18.5,
      sampleUrls: ["https://harbor.example/products/stoneware-mug"],
    });
    // The 18-variant tee counts once, at 29.00, alongside the 9.00 pin.
    expect(rule(report, "missing-brand")).toMatchObject({ productsAffected: 2, valueAtLowestPrice: 38 });
    expect(rule(report, "missing-category")).toMatchObject({ productsAffected: 1, valueAtLowestPrice: 29 });
    expect(rule(report, "gtin-unknown").productsAffected).toBe(4);
    expect(rule(report, "missing-gtin").productsAffected).toBe(0);
    expect(report.overall).toEqual({ productsWithIssues: 3, valueAtLowestPrice: 56.5, affectedWithoutPrice: 0 });

    const text = textOf(result);
    expect(text).toContain("Checked 4 products. Skipped 2 not sellable");
    expect(text).toContain("missing-brand: 2 products, value at lowest listed price 38.00");
    expect(text).toContain("unconverted");
  });

  it("audit_products validates barcodes when the caller supplies them", async () => {
    const c = await connect();
    const products = [
      { handle: "a", vendor: "V", product_type: "T", images: [{ src: "x" }], variants: [{ price: "5.00", barcode: "4006381333931" }] },
      { handle: "b", vendor: "V", product_type: "T", images: [{ src: "x" }], variants: [{ price: "7.00", barcode: "4006381333932" }] },
      { handle: "c", vendor: "V", product_type: "T", images: [{ src: "x" }], variants: [{ price: "3.00", barcode: "" }] },
    ];
    const report = (await call(c, "audit_products", { products })).structuredContent as unknown as AuditReport;
    expect(rule(report, "gtin-unknown").productsAffected).toBe(0);
    expect(rule(report, "invalid-gtin")).toMatchObject({ productsAffected: 1, sampleUrls: ["/products/b"] });
    expect(rule(report, "missing-gtin")).toMatchObject({ productsAffected: 1, sampleUrls: ["/products/c"] });
  });

  it("audit_store audits a (mocked) storefront", async () => {
    const fetchImpl = vi.fn(async () => Response.json(fixture)) as unknown as typeof fetch;
    const c = await connect({ fetch: fetchImpl });

    const result = await call(c, "audit_store", { domain: "https://harbor.example/" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const report = result.structuredContent as unknown as AuditReport;
    expect(report).toMatchObject({ source: "storefront", domain: "harbor.example", complete: true, productsChecked: 4 });
    expect(textOf(result)).toContain("public storefront products.json");
  });

  it("audit_store reports a non-Shopify store as a tool error", async () => {
    const fetchImpl = vi.fn(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    const c = await connect({ fetch: fetchImpl });
    const result = await call(c, "audit_store", { domain: "not-shopify.example" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/probably not a Shopify store/);
  });

  it("explain_rule returns rationale and fix", async () => {
    const c = await connect();
    const result = await call(c, "explain_rule", { ruleId: "gtin-unknown" });
    expect(textOf(result)).toContain("does not include variant barcodes");
    expect(result.structuredContent).toMatchObject({ id: "gtin-unknown", severity: "info" });
  });

  it("rejects an unknown rule id", async () => {
    const c = await connect();
    const result = await call(c, "explain_rule", { ruleId: "no-such-rule" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Input validation error/);
  });
});
