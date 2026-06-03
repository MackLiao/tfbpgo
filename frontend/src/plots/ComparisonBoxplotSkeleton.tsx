import { Skeleton } from "@/components/ui/skeleton";

// Diagram-shaped loading placeholder for the Comparison faceted boxplot.
//
// Sized to the real chart's 460px height (see ComparisonBoxplot layout.height)
// so swapping in <ComparisonBoxplot> once data arrives causes NO layout shift,
// and shaped like the chart — a row of facet columns, each holding a few
// box-and-whisker silhouettes, plus a y-axis stub and a legend strip — so it
// reads as "a boxplot is loading" rather than a featureless grey rectangle.
//
// routes/Comparison.tsx renders this while the top_n query is pending. With
// staleTime=60s and refetchOnWindowFocus=false (main.tsx), that pending window
// is exactly the initial load and any top_n / effect / pvalue change (each
// changes the query key, so there is no cached data to fall back to). The
// top_n query can take several seconds against the real artifact, so this is
// the user's primary "it's working" feedback.

const FACETS = 3;
// Fixed per-facet box heights (% of the plot area) so the silhouette is stable
// across renders — deterministic, no Math.random (which would also break the
// resume-safe constraints and reflow on every pulse).
const BOX_HEIGHTS: ReadonlyArray<ReadonlyArray<number>> = [
  [58, 72, 44],
  [66, 40, 78],
  [52, 63, 36],
];

export function ComparisonBoxplotSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading comparison chart"
      aria-busy="true"
      data-testid="comparison-skeleton"
      className="h-[460px] w-full rounded-md border border-slate-100 p-4"
    >
      {/* Facet titles across the top, mirroring the subplot-title annotations. */}
      <div className="mb-4 flex items-center justify-around gap-4 pl-6">
        {Array.from({ length: FACETS }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-28" />
        ))}
      </div>

      <div className="flex h-[360px] gap-4">
        {/* Shared y-axis. */}
        <Skeleton className="h-full w-1.5" aria-hidden="true" />

        {/* One column per facet; boxes grow from a shared baseline (items-end). */}
        {BOX_HEIGHTS.slice(0, FACETS).map((heights, f) => (
          <div
            key={f}
            className="flex flex-1 items-end justify-center gap-3 border-l border-slate-100 pl-3"
            aria-hidden="true"
          >
            {heights.map((h, b) => (
              <Skeleton
                key={b}
                className="w-9 rounded-sm"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        ))}

        {/* Legend strip on the right, matching the real chart's legend. */}
        <div
          className="flex w-28 flex-col justify-center gap-2 pl-2"
          aria-hidden="true"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-3 w-3 rounded-sm" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Loading comparison chart…</span>
    </div>
  );
}
