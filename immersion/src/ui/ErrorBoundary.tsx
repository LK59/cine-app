import { Component, type ReactNode } from "react";

/** Une erreur de rendu ne doit pas laisser une page noire : elle affiche l'écran de secours. */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[immersion]", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
