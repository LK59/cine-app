"use client";

import { useState } from "react";
import { Loader2, ScanFace } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useRole } from "@/lib/useRole";
import { useXrayAvailable } from "@/lib/xray/client";
import { ROUND_ACTION } from "@/components/cinema/roundAction";

/**
 * « Analyser en priorité » sur une fiche de film ou de série (DECISIONS.md §138, liste de priorité) :
 * l'administrateur fait passer ce titre devant toute l'analyse de la bibliothèque. Un bouton rond de la
 * rangée du bureau (`round`, `DetailIconActions` — la rangée ne grandit pas en hauteur : la fiche tient
 * toujours en une page, §117.4) et une icône sous libellé au téléphone (`icon`).
 *
 * Présentation seulement : rendu pour un administrateur quand l'option est branchée — la route
 * (`/api/admin/xray/scan`, `adminOnly` et le proxy) est la porte. Le rôle n'est demandé qu'une fois
 * l'option connue ouverte (`useXrayAvailable` suit la configuration publique sans la demander) : une
 * fiche sans l'option ne fait aucune requête de plus. La confirmation est discrète (un message bref),
 * l'animation est refusée avec sa raison.
 */
export function XrayPriorityControl({ itemId, variant }: { itemId: string | null | undefined; variant: "round" | "icon" }) {
  const available = useXrayAvailable();
  if (!available || !itemId) return null;
  return <AdminOnly itemId={itemId} variant={variant} />;
}

function AdminOnly({ itemId, variant }: { itemId: string; variant: "round" | "icon" }) {
  const { role } = useRole();
  if (role !== "admin") return null;
  return <PriorityButton itemId={itemId} variant={variant} />;
}

function PriorityButton({ itemId, variant }: { itemId: string; variant: "round" | "icon" }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const label = t("xrayScan.prioritize");

  async function add() {
    setBusy(true);
    const res = await fetch("/api/admin/xray/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prioritize", itemId }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      toast.success(t("xrayScan.prioritized"));
      return;
    }
    const body = (await res?.json().catch(() => null)) as { error?: string } | null;
    toast.error(t(body?.error === "animation" ? "xrayScan.animationRefused" : "xrayScan.actionFailed"));
  }

  const icon = busy ? <Loader2 size={variant === "round" ? 19 : 22} className="animate-spin" /> : <ScanFace size={variant === "round" ? 19 : 22} />;
  return variant === "round" ? (
    <button type="button" data-detail-menu data-round-action="xray-priority" aria-label={label} title={label} disabled={busy} onClick={() => void add()} className={ROUND_ACTION}>
      {icon}
    </button>
  ) : (
    <button type="button" data-xray-priority="" disabled={busy} onClick={() => void add()} data-liquid-pan="icon" className="flex w-16 flex-col items-center gap-1.5 text-white">
      {icon}
      <span className="text-center text-xs leading-tight text-muted">{label}</span>
    </button>
  );
}
