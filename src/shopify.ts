import { z } from "zod";
import { productSchema, type Product } from "./product.js";
import { VERSION } from "./version.js";

export const USER_AGENT = `catalog-mcp/${VERSION} (+https://github.com/msalihk/catalog-mcp)`;
export const PAGE_SIZE = 250;
export const DEFAULT_MAX_PRODUCTS = 1000;
export const MAX_PRODUCTS_CAP = 5000;
export const MIN_REQUEST_INTERVAL_MS = 1000;
export const MAX_429_RETRIES = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export class StoreFetchError extends Error {
  override name = "StoreFetchError";
}

export interface FetchStoreOptions {
  domain: string;
  maxProducts?: number | undefined;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface StoreFetchResult {
  domain: string;
  products: Product[];
  /** False when maxProducts stopped the scan before the last page. */
  complete: boolean;
  maxProducts: number;
  requests: number;
}

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home.arpa"];

/**
 * Accepts "shop.com", "https://shop.com/", "shop.com/collections/x" and returns
 * the bare hostname. Only public DNS names are allowed: IP literals, ports and
 * local names are refused so the tool can't be pointed at a private network.
 */
export function normalizeDomain(input: string): string {
  let raw = input.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new StoreFetchError(`"${input}" is not a valid URL.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new StoreFetchError(`Unsupported URL scheme in "${input}".`);
    }
    if (url.port) throw new StoreFetchError(`Ports are not supported: "${input}".`);
    raw = url.hostname;
  } else {
    raw = raw.split(/[/?#]/, 1)[0] ?? "";
  }
  raw = raw.replace(/\.$/, "");
  if (!HOSTNAME.test(raw) || PRIVATE_SUFFIXES.some((s) => raw.endsWith(s))) {
    throw new StoreFetchError(`"${input}" is not a public store domain (expected something like "shop.example.com").`);
  }
  return raw;
}

export function clampMaxProducts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PRODUCTS;
  return Math.min(Math.max(1, Math.floor(value)), MAX_PRODUCTS_CAP);
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const pageSchema = z.object({ products: z.array(productSchema) });

/**
 * Reads a Shopify store's public products.json one page at a time. Requests to
 * the store are strictly sequential and at least MIN_REQUEST_INTERVAL_MS apart;
 * 429 responses back off exponentially, honouring Retry-After when present.
 */
export async function fetchStoreProducts(options: FetchStoreOptions): Promise<StoreFetchResult> {
  const domain = normalizeDomain(options.domain);
  const maxProducts = clampMaxProducts(options.maxProducts);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  let lastRequestAt: number | null = null;
  let requests = 0;

  const politeGet = async (url: string): Promise<Response> => {
    if (lastRequestAt !== null) {
      const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = Date.now();
    requests++;
    try {
      return await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new StoreFetchError(`Could not reach ${domain}: ${reason}`);
    }
  };

  const getPage = async (page: number): Promise<Response> => {
    const url = `https://${domain}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    for (let attempt = 0; ; attempt++) {
      const res = await politeGet(url);
      if (res.status !== 429) return res;
      if (attempt >= MAX_429_RETRIES) {
        throw new StoreFetchError(
          `${domain} kept responding 429 Too Many Requests after ${MAX_429_RETRIES} retries. Try again later.`,
        );
      }
      const backoff = parseRetryAfter(res.headers.get("retry-after"), Date.now()) ?? BASE_BACKOFF_MS * 2 ** attempt;
      await sleep(Math.min(backoff, MAX_BACKOFF_MS));
    }
  };

  const products: Product[] = [];
  for (let page = 1; ; page++) {
    const res = await getPage(page);
    const batch = await readPage(res, domain);
    products.push(...batch);

    if (products.length >= maxProducts) {
      // A full last page means there may be more we did not fetch.
      const complete = products.length === maxProducts && batch.length < PAGE_SIZE;
      return { domain, products: products.slice(0, maxProducts), complete, maxProducts, requests };
    }
    if (batch.length < PAGE_SIZE) {
      return { domain, products, complete: true, maxProducts, requests };
    }
  }
}

async function readPage(res: Response, domain: string): Promise<Product[]> {
  if (res.status === 401 || res.status === 403) {
    throw new StoreFetchError(
      `${domain} refused the request (HTTP ${res.status}). The store may be password-protected or block automated access.`,
    );
  }
  if (res.status === 404) {
    throw new StoreFetchError(
      `${domain} has no /products.json (HTTP 404). It is probably not a Shopify store, or the endpoint is disabled.`,
    );
  }
  if (!res.ok) {
    throw new StoreFetchError(`${domain} returned HTTP ${res.status} for /products.json.`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new StoreFetchError(
      `${domain}/products.json did not return JSON. The store may be password-protected or not a Shopify store.`,
    );
  }
  const parsed = pageSchema.safeParse(body);
  if (!parsed.success) {
    throw new StoreFetchError(
      `${domain}/products.json did not look like a Shopify product list. It is probably not a Shopify store.`,
    );
  }
  return parsed.data.products;
}
