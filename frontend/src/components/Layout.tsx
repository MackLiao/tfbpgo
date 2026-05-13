import type { ReactNode } from "react";
import { Nav } from "./Nav";
import { ErrorBoundary } from "./ErrorBoundary";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <main className="container mx-auto flex-1 p-4">
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>
    </div>
  );
}
