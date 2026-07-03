import { NextResponse } from "next/server";
import { HttpError } from "@/lib/http";

// ─── Error kind taxonomy ──────────────────────────────────────────────────────

export type ErrorKind =
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "unreachable"
  | "missing_api_key"
  | "invalid_api_key"
  | "not_found"
  | "unexpected_response"
  | "unknown";

export interface AppError {
  kind: ErrorKind;
  message: string;       // User-facing French message
  detail?: string;       // Technical detail (admin/debug only)
}

// ─── Classification ───────────────────────────────────────────────────────────

export function classifyError(err: unknown): AppError {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    if (err.name === "AbortError" || msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out")) {
      return { kind: "timeout", message: "Le service ne répond pas (timeout)", detail: err.message };
    }

    if (err instanceof HttpError) {
      if (err.status === 401) return { kind: "unauthorized", message: "Clé API invalide ou session expirée", detail: err.message };
      if (err.status === 403) return { kind: "forbidden", message: "Accès refusé", detail: err.message };
      if (err.status === 404) return { kind: "not_found", message: "Ressource introuvable", detail: err.message };
      return { kind: "unexpected_response", message: `Réponse inattendue (${err.status})`, detail: err.message };
    }

    if (msg.includes("clé api non configurée") || msg.includes("missing") || msg.includes("not configured")) {
      return { kind: "missing_api_key", message: "Variable d'environnement manquante", detail: err.message };
    }
    if (msg.includes("clé api invalide") || msg.includes("invalid") || msg.includes("unauthorized")) {
      return { kind: "invalid_api_key", message: "Clé API invalide", detail: err.message };
    }
    if (
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("network") ||
      msg.includes("fetch failed") ||
      msg.includes("inaccessible") ||
      msg.includes("unreachable")
    ) {
      return { kind: "unreachable", message: "Service inaccessible", detail: err.message };
    }

    return { kind: "unknown", message: "Erreur inattendue", detail: err.message };
  }

  return { kind: "unknown", message: "Erreur inconnue", detail: String(err) };
}

// ─── HTTP response helpers ────────────────────────────────────────────────────

export function errorResponse(err: unknown, status = 502): NextResponse {
  const appErr = classifyError(err);
  return NextResponse.json(
    { error: appErr.message, kind: appErr.kind, detail: appErr.detail },
    { status }
  );
}

export function serviceUnavailable(serviceName: string): NextResponse {
  return NextResponse.json(
    {
      error: `${serviceName} est temporairement indisponible`,
      kind: "unreachable" as ErrorKind,
    },
    { status: 503 }
  );
}

// ─── User-facing label ────────────────────────────────────────────────────────

export function errorLabel(kind: ErrorKind): string {
  const labels: Record<ErrorKind, string> = {
    timeout:              "Service trop lent",
    unauthorized:         "Clé API invalide",
    forbidden:            "Accès refusé",
    unreachable:          "Service inaccessible",
    missing_api_key:      "Configuration manquante",
    invalid_api_key:      "Clé API invalide",
    not_found:            "Introuvable",
    unexpected_response:  "Réponse inattendue",
    unknown:              "Erreur",
  };
  return labels[kind] ?? "Erreur";
}
