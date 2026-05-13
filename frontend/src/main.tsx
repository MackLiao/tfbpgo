import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { refreshArtifactVersion } from "./api/client";
import "./styles/globals.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // Stale-while-revalidate per spec §7.4
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

async function boot() {
  await refreshArtifactVersion(); // must succeed before first query
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void boot();
