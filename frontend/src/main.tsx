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

boot().catch((err: unknown) => {
  // Surface a visible error instead of leaving a blank page when the initial
  // /api/version call fails (network down, backend not responding, etc.).
  // Build the DOM via createElement + textContent so an error message that
  // ever ends up attacker-controllable (regressions in /api/version) cannot
  // become a reflected-XSS sink. innerHTML is intentionally NOT used here.
  const root = document.getElementById("root");
  if (!root) return;
  const message = err instanceof Error ? err.message : String(err);

  const container = document.createElement("div");
  container.style.cssText = "padding:2rem;font-family:system-ui;color:#a00";

  const h1 = document.createElement("h1");
  h1.textContent = "Failed to load TFBPShiny";
  container.appendChild(h1);

  const p = document.createElement("p");
  p.textContent = "Could not reach /api/version. Try refreshing in a moment.";
  container.appendChild(p);

  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;font-size:0.85em";
  pre.textContent = message;
  container.appendChild(pre);

  root.replaceChildren(container);
});
