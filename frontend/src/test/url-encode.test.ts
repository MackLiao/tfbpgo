import { describe, it, expect } from "vitest";
import { canonicalParams, packRegulators } from "@/lib/url-encode";

describe("canonicalParams", () => {
  it("sorts keys", () => {
    const p = new URLSearchParams("z=1&a=2");
    expect(canonicalParams(p).toString()).toBe("a=2&z=1");
  });
});

describe("packRegulators", () => {
  it("dedupes and caps at 30", () => {
    const tags = Array(50).fill("YBR289W");
    expect(packRegulators(tags)).toBe("YBR289W");
  });
  it("uppercases and trims", () => {
    expect(packRegulators([" ybr289w "])).toBe("YBR289W");
  });
});
