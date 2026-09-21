import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_SIZE,
  USER_AGENT,
  fetchStoreProducts,
  normalizeDomain,
  parseRetryAfter,
  type StoreFetchResult,
} from "../src/shopify.js";
import { VERSION } from "../src/version.js";
import { makeProduct } from "./helpers.js";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const page = (n: number) => ({ products: Array.from({ length: n }, () => makeProduct()) });

interface Call {
  url: string;
  at: number;
  headers: Headers;
}

/** A fetch stub that serves the given responses in order and records when each call happened. */
function scriptedFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), at: Date.now(), headers: new Headers(init?.headers) });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected request #${calls.length}: ${String(input)}`);
    return next();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** Runs the fetch to completion under fake timers. */
async function run(options: Parameters<typeof fetchStoreProducts>[0]): Promise<StoreFetchResult> {
  const promise = fetchStoreProducts(options);
  // Attach a handler now so a rejection isn't reported as unhandled while timers run.
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeDomain", () => {
  it.each([
    ["shop.example.com", "shop.example.com"],
    ["  Shop.Example.com  ", "shop.example.com"],
    ["https://shop.example.com/", "shop.example.com"],
    ["shop.example.com/collections/all", "shop.example.com"],
    ["my-store.myshopify.com.", "my-store.myshopify.com"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(["localhost", "127.0.0.1", "http://10.0.0.1/", "shop.example.com:8080", "https://x.com:444", "printer.local", "ftp://shop.com", "not a domain"])(
    "refuses %j",
    (input) => {
      expect(() => normalizeDomain(input)).toThrow(/not a public store domain|Ports|scheme|valid URL/);
    },
  );
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});

describe("fetchStoreProducts", () => {
  it("pages sequentially, at least one second apart, until a short page", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => json(page(PAGE_SIZE)), () => json(page(PAGE_SIZE)), () => json(page(3))]);

    const result = await run({ domain: "https://shop.example.com/", fetch: fetchImpl });

    expect(result).toMatchObject({ domain: "shop.example.com", complete: true, requests: 3 });
    expect(result.products).toHaveLength(2 * PAGE_SIZE + 3);
    expect(calls.map((c) => c.url)).toEqual([
      "https://shop.example.com/products.json?limit=250&page=1",
      "https://shop.example.com/products.json?limit=250&page=2",
      "https://shop.example.com/products.json?limit=250&page=3",
    ]);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    }
    expect(calls[0]!.headers.get("user-agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toContain("github.com/msalihk/catalog-mcp");
  });

  it("backs off on 429, honouring Retry-After, then exponentially without it", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "10" } }),
      () => new Response("slow down", { status: 429 }),
      () => new Response("slow down", { status: 429 }),
      () => json(page(2)),
    ]);

    const result = await run({ domain: "shop.example.com", fetch: fetchImpl });

    expect(result.products).toHaveLength(2);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    // Retry-After wins on attempt 0; attempts 1 and 2 fall back to 2s * 2^attempt.
    expect(gaps).toEqual([10_000, 4_000, 8_000]);
  });

  it("gives up after repeated 429s with a clear error", async () => {
    const { fetchImpl, calls } = scriptedFetch(Array.from({ length: 6 }, () => () => new Response("", { status: 429 })));
    await expect(run({ domain: "shop.example.com", fetch: fetchImpl })).rejects.toThrow(/kept responding 429/);
    expect(calls).toHaveLength(6);
  });

  it("stops at maxProducts and marks the result partial", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => json(page(PAGE_SIZE)), () => json(page(PAGE_SIZE))]);
    const result = await run({ domain: "shop.example.com", maxProducts: 300, fetch: fetchImpl });
    expect(calls).toHaveLength(2);
    expect(result.products).toHaveLength(300);
    expect(result.complete).toBe(false);
  });

  it("is complete when maxProducts is reached exactly on the last, short page", async () => {
    const { fetchImpl } = scriptedFetch([() => json(page(PAGE_SIZE)), () => json(page(50))]);
    const result = await run({ domain: "shop.example.com", maxProducts: 300, fetch: fetchImpl });
    expect(result).toMatchObject({ complete: true, maxProducts: 300 });
  });

  it("caps maxProducts at 5000", async () => {
    const { fetchImpl } = scriptedFetch([() => json(page(1))]);
    expect((await run({ domain: "shop.example.com", maxProducts: 1e9, fetch: fetchImpl })).maxProducts).toBe(5000);
  });

  it.each([
    [() => new Response("nope", { status: 404 }), /not a Shopify store/],
    [() => new Response("nope", { status: 403 }), /password-protected or block automated access/],
    [() => new Response("<html>password</html>", { status: 200, headers: { "content-type": "text/html" } }), /did not return JSON/],
    [() => json({ items: [] }), /did not look like a Shopify product list/],
    [() => new Response("", { status: 500 }), /HTTP 500/],
  ])("explains a non-Shopify or blocked store (%#)", async (response, message) => {
    const { fetchImpl } = scriptedFetch([response]);
    await expect(run({ domain: "shop.example.com", fetch: fetchImpl })).rejects.toThrow(message);
  });

  it("wraps network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(run({ domain: "shop.example.com", fetch: fetchImpl })).rejects.toThrow("Could not reach shop.example.com: fetch failed");
  });
});

it("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
