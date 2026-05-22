// Frontend FilterSpec helper — Task C5.
//
// The generated `Schemas["FilterSpec"]` from OpenAPI is strict (`{type,
// value}` only). The audit requires a `from_pair: [displayA, displayB]`
// annotation on filters produced by the "Select N common regulators" flow
// (docs/parity/select_datasets.md rows 15, 30, 31).
//
// Wire choice: round-trip the annotation through `?filters=` JSON as an
// extra `fromPair` field on the FilterSpec object. The Go backend uses
// `encoding/json` with the default struct decoder, which silently ignores
// unknown fields — so the annotation is invisible to the server. Keeping
// it in the same URL key as the filter itself means a shared link
// preserves the "this filter came from that pair" affordance without
// requiring a second URL parameter.
//
// This module is the only place that knows about `fromPair`, so leaking
// the type through every component import is avoided.

import type { Schemas } from "@/api/client";

type WireFilterSpec = Schemas["FilterSpec"];

/**
 * FilterSpec as the frontend sees it: the OpenAPI wire shape PLUS the
 * optional `fromPair` annotation. Treat this as a superset — every
 * AnnotatedFilterSpec serializes back to the wire shape safely.
 */
export type AnnotatedFilterSpec = WireFilterSpec & {
  /**
   * Display names (`[A, B]`) of the dataset pair this filter was derived
   * from via the "Select N common regulators" flow. Frontend-only;
   * stripped before any backend interaction is not needed because the
   * backend ignores unknown JSON fields.
   */
  fromPair?: [string, string];
};

/** Build a regulator_locus_tag filter tagged with its origin pair. */
export function buildFromPairFilter(
  locusTags: string[],
  pair: [string, string],
): AnnotatedFilterSpec {
  return {
    type: "categorical",
    value: locusTags,
    fromPair: pair,
  };
}

/** Strip the `fromPair` annotation, returning the wire-shape FilterSpec. */
export function stripFromPair(spec: AnnotatedFilterSpec): WireFilterSpec {
  const { fromPair: _ignored, ...rest } = spec;
  return rest;
}

/** Read the `fromPair` annotation, if any. */
export function readFromPair(
  spec: AnnotatedFilterSpec | WireFilterSpec | null | undefined,
): [string, string] | null {
  if (!spec) return null;
  const anno = (spec as AnnotatedFilterSpec).fromPair;
  if (
    Array.isArray(anno) &&
    anno.length === 2 &&
    typeof anno[0] === "string" &&
    typeof anno[1] === "string"
  ) {
    return [anno[0], anno[1]];
  }
  return null;
}

/**
 * The canonical field name carrying the from_pair regulator filter. Used
 * by SelectionMatrix to find the highlighted cell and by Select.tsx to
 * clean up the annotation.
 */
export const REGULATOR_LOCUS_TAG_FIELD = "regulator_locus_tag";
