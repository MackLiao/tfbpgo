import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Nav } from "./Nav";
import { ErrorBoundary } from "./ErrorBoundary";
import { api } from "@/api/client";
import { qk } from "@/lib/query-keys";

// HOME-3: show a slim "Datasets loading" banner while the top-level /datasets
// query is in flight on first paint (mirrors reference app.py:179-182, class
// pending-banner). We issue the query here at the layout level — rather than
// in Select.tsx — so it fires on EVERY page (Home, Binding, Perturbation, …)
// and the user gets feedback on any tab, not just the dataset-selection tab.
// TanStack Query deduplicates this against Select.tsx's identical useQuery call
// (same key), so there is never a second network request.
function DatasetsBanner() {
  const { isPending } = useQuery({
    queryKey: qk.datasets(),
    queryFn: ({ signal }) => api.datasets(signal),
    // staleTime comes from the global QueryClient default (60 s); no override
    // needed here. The banner disappears as soon as any observer resolves the
    // query, which also benefits the Select page if it mounts later.
  });

  if (!isPending) return null;

  return (
    <div
      className="pending-banner"
      role="status"
      aria-live="polite"
      data-testid="datasets-loading-banner"
    >
      Datasets loading. This typically takes less than 5 seconds. Thank you for
      your patience.
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <DatasetsBanner />
      <main className="container mx-auto flex-1 p-4">
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>
    </div>
  );
}
