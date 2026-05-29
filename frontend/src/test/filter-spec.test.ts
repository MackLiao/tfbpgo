import { describe, it, expect } from "vitest";
import {
  REGULATOR_LOCUS_TAG_FIELD,
  buildFromPairFilter,
  readFromPair,
  stripFromPair,
  readApplyToAll,
  withApplyToAll,
  defaultApplyToAll,
} from "@/lib/filter-spec";

describe("filter-spec applyToAll annotation", () => {
  it("withApplyToAll sets the flag explicitly (both true and false)", () => {
    const on = withApplyToAll({ type: "categorical", value: ["YPD"] }, true);
    expect(readApplyToAll(on)).toBe(true);
    const off = withApplyToAll({ type: "categorical", value: ["YPD"] }, false);
    expect(readApplyToAll(off)).toBe(false);
  });

  it("readApplyToAll returns undefined when the annotation is absent", () => {
    expect(readApplyToAll({ type: "bool", value: true })).toBeUndefined();
    expect(readApplyToAll(null)).toBeUndefined();
    expect(readApplyToAll(undefined)).toBeUndefined();
  });

  it("round-trips applyToAll through JSON.stringify / parse", () => {
    const spec = withApplyToAll({ type: "categorical", value: ["a", "b"] }, true);
    const parsed = JSON.parse(JSON.stringify(spec));
    expect(readApplyToAll(parsed)).toBe(true);
    expect(parsed.type).toBe("categorical");
    expect(parsed.value).toEqual(["a", "b"]);
  });

  it("coexists with the fromPair annotation without clobbering it", () => {
    const base = buildFromPairFilter(["YAL001C"], ["Calling Cards", "Hackett"]);
    const both = withApplyToAll(base, true);
    expect(readApplyToAll(both)).toBe(true);
    expect(readFromPair(both)).toEqual(["Calling Cards", "Hackett"]);
    // stripFromPair removes only fromPair, leaving applyToAll + wire fields.
    const stripped = stripFromPair(both);
    expect(readFromPair(stripped)).toBeNull();
    expect(readApplyToAll(stripped)).toBe(true);
  });

  it("defaultApplyToAll is true for the regulator field and experimental_condition role, false otherwise", () => {
    expect(defaultApplyToAll(REGULATOR_LOCUS_TAG_FIELD)).toBe(true);
    expect(defaultApplyToAll("condition", "experimental_condition")).toBe(true);
    expect(defaultApplyToAll("condition")).toBe(false);
    expect(defaultApplyToAll("some_field", "")).toBe(false);
    expect(defaultApplyToAll("some_field")).toBe(false);
  });
});
