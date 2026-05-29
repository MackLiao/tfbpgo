import { lazy, Suspense } from "react";
import { PlotSkeleton } from "@/components/PlotSkeleton";

// Lazy wrapper around react-plotly.js so the (large) Plotly bundle is only
// fetched when a chart first mounts.
//
// Drift-fix contract for any RESPONSIVE chart rendered through PlotLazy
// (config.responsive:true + useResizeHandler) whose data changes at runtime:
//
//   1. Pass a DEFINITE pixel `style.height` (matching `layout.height`) — NOT
//      "100%". A percentage height against a content-sized ancestor lets
//      Plotly's resize read offsetHeight, grow the container, re-read, and
//      ratchet the chart bigger on every window/panel resize.
//   2. Set a STABLE `layout.uirevision` (a constant). Layout objects are
//      rebuilt fresh each render, so without uirevision every re-render fires
//      Plotly.react() and resets the user's zoom/pan/legend selections.
//
// Fixed-size charts (responsive:false, explicit width/height, no
// useResizeHandler — e.g. the scatter pairs) are exempt from (1).

const PlotImpl = lazy(async () => {
  const Plotly = (await import("./plotly-bundle")).default;
  const factory = (await import("react-plotly.js/factory")).default;
  const Plot = factory(Plotly as any);
  return { default: Plot };
});

export function PlotLazy(props: React.ComponentProps<typeof PlotImpl>) {
  return (
    <Suspense fallback={<PlotSkeleton />}>
      <PlotImpl {...props} />
    </Suspense>
  );
}
