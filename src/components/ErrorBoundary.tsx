"use client";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@/lib/reportClientError";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * Ce que la barrière entoure, pour le journal. Sans nom, la ligne dit seulement « un composant »
   * — et à la racine, celle qui entoure le lecteur ne se distinguerait pas de celle des notices.
   */
  name?: string;
}
interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(): State { return { hasError: true }; }
  /**
   * Disparaître sans rien dire était tout le problème : autour du lecteur, cette barrière faisait
   * s'évanouir le film en plein écran, et rien nulle part n'en gardait la trace. Elle continue de
   * protéger le reste de la page — elle le dit, simplement.
   */
  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = info.componentStack?.trim().split("\n").slice(0, 4).map((line) => line.trim()).join(" < ");
    reportClientError(error, `component:${this.props.name ?? "anonyme"}`, where ? { componentStack: where } : undefined);
  }
  render() {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}
