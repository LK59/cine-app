"use client";

// Les vues de l'activité, dans l'adresse du cinéma (`#activite=…`).
//
// L'activité vivait dans la gestion, sous sa barre latérale ; elle est passée dans le cinéma le
// 24/09/2026, en panneau, à la demande de l'administrateur. Chaque vue est une entrée
// d'historique : le retour remonte de la séance à la fiche, de la fiche à la vue d'ensemble, puis
// au panneau Compte d'où l'on est parti — comme partout ailleurs dans le cinéma.

import { cinemaNavigate } from "@/lib/cinemaRoute";

export type LogsPreset = { source?: string; type?: string; user?: string; session?: string; days?: number };

export type ActivityView =
  | { kind: "overview" }
  | { kind: "account"; id: string }
  | { kind: "seance"; id: string }
  | { kind: "logs"; preset: LogsPreset };

export function encodeView(view: ActivityView): string {
  switch (view.kind) {
    case "overview":
      return "1";
    case "account":
      return `compte:${view.id}`;
    case "seance":
      return `seance:${view.id}`;
    case "logs": {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(view.preset)) if (v !== undefined && v !== "") params.set(k, String(v));
      const query = params.toString();
      return query ? `journaux:${query}` : "journaux";
    }
  }
}

export function decodeView(raw: string | null): ActivityView | null {
  if (!raw) return null;
  if (raw.startsWith("compte:")) return { kind: "account", id: raw.slice(7) };
  if (raw.startsWith("seance:")) return { kind: "seance", id: raw.slice(7) };
  if (raw === "journaux" || raw.startsWith("journaux:")) {
    const params = new URLSearchParams(raw.slice(9));
    const days = params.get("days");
    return {
      kind: "logs",
      preset: {
        source: params.get("source") ?? undefined,
        type: params.get("type") ?? undefined,
        user: params.get("user") ?? undefined,
        session: params.get("session") ?? undefined,
        days: days !== null ? Number(days) : undefined,
      },
    };
  }
  return { kind: "overview" };
}

export function goTo(view: ActivityView): void {
  cinemaNavigate({ activity: encodeView(view) });
}

/**
 * Un lien vers une vue de l'activité. Une vraie adresse dans `href` — un clic du milieu ouvre la
 * vue dans un autre onglet —, et une navigation dans l'historique du cinéma pour un clic simple.
 */
export function ActivityLink({
  to,
  className,
  title,
  children,
}: {
  to: ActivityView;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const encoded = encodeView(to);
  return (
    <a
      href={`/#${new URLSearchParams({ activite: encoded })}`}
      title={title}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        cinemaNavigate({ activity: encoded });
      }}
    >
      {children}
    </a>
  );
}
