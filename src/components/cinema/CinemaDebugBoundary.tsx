"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  info: string | null;
}

// Temporary, Cinema-Mode-only debug boundary — unlike the shared ErrorBoundary (which just
// swallows the error and shows nothing/a fallback), this renders the actual message + component
// stack directly on screen. Added specifically to diagnose a blank-page report where the browser
// console only showed a hydration warning (React #418, which self-heals) and no visible second
// error — this makes whatever throws during the *client* render of CinemaHero/the rows visible
// without needing devtools. Safe to remove once Cinema Mode is confirmed stable.
export class CinemaDebugBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[CinemaMode] render crashed:", error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-2xl p-8 text-left">
          <p className="mb-2 text-sm font-semibold text-red-400">Cinema Mode crashed:</p>
          <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/50 p-4 text-xs text-red-300">
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack}
            {this.state.info ? `\n\n--- component stack ---${this.state.info}` : ""}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
