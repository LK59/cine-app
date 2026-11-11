import { Component, type ReactNode } from "react";
import { reportError } from "../lib/errorLog";

/**
 * Une erreur de rendu ne doit pas laisser une page noire : elle affiche l'écran de secours. Avec `report`, l'erreur
 * part aussi au serveur (`errorLog.ts`) — la barrière de toute la page (l'écran « Crashed ») : un plantage chez un
 * visiteur n'en laissait aucune trace. Les barrières locales (le canapé, une fiche du panneau) ont leur repli et
 * n'envoient rien.
 */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode; report?: "crash" }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[immersion]", error);
    if (this.props.report) reportError(error, this.props.report);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
