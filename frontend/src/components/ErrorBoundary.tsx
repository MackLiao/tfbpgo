import React from "react";

type State = { error: Error | null };

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary", error);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-red-300 bg-red-50 p-4">
          <p className="font-semibold text-red-700">Something went wrong.</p>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-red-900">
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
