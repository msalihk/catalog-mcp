import { describe, expect, it } from "vitest";
import { checkGtin, gs1CheckDigit } from "../src/gtin.js";

// Each valid code below had its check digit worked out by hand with the GS1
// weights (3,1,3,1… from the rightmost data digit) before being used here.
describe("gs1CheckDigit", () => {
  it("computes the check digit for each GTIN length", () => {
    expect(gs1CheckDigit("9638507")).toBe(4); // GTIN-8: sum 86
    expect(gs1CheckDigit("03600029145")).toBe(2); // GTIN-12: sum 58
    expect(gs1CheckDigit("400638133393")).toBe(1); // GTIN-13: sum 89
    expect(gs1CheckDigit("1003600029145")).toBe(9); // GTIN-14: sum 61
  });

  it("returns 0 when the weighted sum is already a multiple of ten", () => {
    // 1*3 + 2*1 + 5*3 = 20
    expect(gs1CheckDigit("521")).toBe(0);
  });
});

describe("checkGtin", () => {
  it.each([
    ["96385074", "GTIN-8"],
    ["036000291452", "GTIN-12 / UPC-A"],
    ["4006381333931", "GTIN-13 / EAN-13"],
    ["10036000291459", "GTIN-14"],
    ["00036000291452", "UPC-A padded to 14 digits"],
  ])("accepts %s (%s)", (code) => {
    expect(checkGtin(code).valid).toBe(true);
  });

  it("tolerates spaces and hyphens", () => {
    const result = checkGtin(" 4006381-333931 ");
    expect(result).toEqual({ valid: true, normalized: "4006381333931" });
  });

  it.each([
    ["4006381333932", "check digit is 2, expected 1"],
    ["036000291453", "check digit is 3, expected 2"],
    ["96385070", "check digit is 0, expected 4"],
  ])("rejects %s with a wrong check digit", (code, reason) => {
    expect(checkGtin(code)).toMatchObject({ valid: false, reason });
  });

  it("rejects unsupported lengths", () => {
    expect(checkGtin("12345")).toMatchObject({ valid: false });
    expect(checkGtin("40063813339310")).toMatchObject({ valid: false }); // 14 digits, bad check
    expect(checkGtin("123456789012345")).toMatchObject({
      valid: false,
      reason: "has 15 digits; a GTIN has 8, 12, 13 or 14",
    });
  });

  it("rejects non-digit values and all-zero placeholders", () => {
    expect(checkGtin("ABC-12345")).toMatchObject({ valid: false });
    expect(checkGtin("0000000000000")).toMatchObject({ valid: false });
  });
});
