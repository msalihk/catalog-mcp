/**
 * GTIN validation using the GS1 mod-10 check digit.
 *
 * Covers GTIN-8 (EAN-8), GTIN-12 (UPC-A), GTIN-13 (EAN-13) and GTIN-14.
 */

const VALID_LENGTHS = new Set([8, 12, 13, 14]);

export type GtinCheck =
  | { valid: true; normalized: string }
  | { valid: false; normalized: string; reason: string };

/** Strip the separators people commonly type into barcode fields. */
export function normalizeGtin(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/**
 * Computes the GS1 check digit for the data digits (everything except the
 * final check digit). Weights alternate 3,1,3,1… starting from the rightmost
 * data digit, which is what makes the same routine work for every length.
 */
export function gs1CheckDigit(dataDigits: string): number {
  let sum = 0;
  for (let i = 0; i < dataDigits.length; i++) {
    const digit = dataDigits.charCodeAt(dataDigits.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function checkGtin(raw: string): GtinCheck {
  const normalized = normalizeGtin(raw);
  if (!/^\d+$/.test(normalized)) {
    return { valid: false, normalized, reason: "contains characters other than digits" };
  }
  if (!VALID_LENGTHS.has(normalized.length)) {
    return {
      valid: false,
      normalized,
      reason: `has ${normalized.length} digits; a GTIN has 8, 12, 13 or 14`,
    };
  }
  // An all-zero code passes the checksum but is only ever a placeholder.
  if (/^0+$/.test(normalized)) {
    return { valid: false, normalized, reason: "is all zeros (placeholder value)" };
  }
  const expected = gs1CheckDigit(normalized.slice(0, -1));
  const actual = Number(normalized.at(-1));
  if (expected !== actual) {
    return {
      valid: false,
      normalized,
      reason: `check digit is ${actual}, expected ${expected}`,
    };
  }
  return { valid: true, normalized };
}
