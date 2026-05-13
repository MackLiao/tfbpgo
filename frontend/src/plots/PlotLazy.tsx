import { lazy, Suspense } from "react";
import { PlotSkeleton } from "@/components/PlotSkeleton";

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
