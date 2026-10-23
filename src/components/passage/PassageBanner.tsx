"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { usePlaybackMode } from "@/components/PlaybackProvider";
import { fetcher } from "@/lib/swr";
import { passageFlags, registerPassageOpener } from "@/lib/passage/client";
import { PassageDialog } from "./PassageDialog";

/**
 * L'invitation au passage vers la nouvelle adresse, sur l'ancienne (DECISIONS.md §119) : un bandeau
 * discret en haut de l'écran, « Laterna a une nouvelle adresse — Passer ».
 *
 * Seulement quand l'installation annonce une nouvelle adresse (`GET /api/passage`, tiré du réglage
 * du déploiement), jamais sur la nouvelle elle-même (l'hôte de la page comparé à celui de la
 * destination), jamais pendant un film (le lecteur ouvert, plein écran ou réduit) ni par-dessus
 * l'écran d'accueil d'un premier lancement. Refermé — à la croix ou après « Passer » —, il revient le
 * lendemain, une fois par jour (`cine:passage-banner-closed`, le jour local : `passageFlags`).
 *
 * Il porte aussi la fenêtre du passage pour le lien de la page Nouveautés (`openPassageFor`) : ce
 * lien l'ouvre même bandeau refermé, puisque c'est un geste explicite.
 */
export function PassageBanner() {
  const t = useT();
  const mode = usePlaybackMode();
  const { data } = useSWR<{ target: string | null }>("/api/passage", fetcher, { revalidateOnFocus: false });
  // Pas par-dessus l'écran d'accueil d'un premier lancement, comme l'invitation aux notifications.
  const { data: onboarding } = useSWR<{ pending?: boolean }>("/api/onboarding", fetcher, { revalidateOnFocus: false });
  const [closed, setClosed] = useState(() => (typeof window === "undefined" ? true : passageFlags.bannerClosed()));
  const [open, setOpen] = useState(false);
  // Lu une fois : monté sans rendu serveur (`PlayerShell`), l'adresse de la page ne change pas.
  const [here] = useState(() => (typeof window === "undefined" ? "" : window.location.host));

  const target = data?.target ?? null;
  let targetHost: string | null = null;
  try {
    targetHost = target ? new URL(target).host : null;
  } catch {
    targetHost = null;
  }
  // Sur la nouvelle adresse, rien : on y est déjà.
  const elsewhere = targetHost !== null && here !== "" && here !== targetHost;

  useEffect(() => {
    if (!elsewhere || !targetHost) return;
    registerPassageOpener((link) => {
      try {
        if (new URL(link).host !== targetHost) return false;
      } catch {
        return false;
      }
      setOpen(true);
      return true;
    });
    return () => registerPassageOpener(null);
  }, [elsewhere, targetHost]);

  if (!elsewhere || !target) return null;

  return (
    <>
      {!closed && mode === "closed" && onboarding?.pending !== true && !open && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-60 flex justify-center px-3"
          // Sous la barre du haut (logo, Films/Séries, téléchargements), pas dessus : posé au bord, il
          // recouvrait ses boutons sur téléphone (essai de bout en bout, 23/10/2026).
          style={{ paddingTop: "calc(max(env(safe-area-inset-top), 0.75rem) + 3.5rem)" }}
        >
          <div role="region" aria-label={t("passage.banner.text")} data-passage-banner="" className="glass-panel pointer-events-auto flex items-center gap-2 rounded-full py-1 pl-4 pr-1 shadow-glow">
            <span className="text-[12px] text-white/85">{t("passage.banner.text")}</span>
            <button
              type="button"
              onClick={() => {
                // « Passer » vaut une fermeture pour la journée : la fenêtre refermée, le bandeau ne
                // revient que demain.
                passageFlags.closeBanner();
                setClosed(true);
                setOpen(true);
              }}
              data-passage-open="" className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-black hover:bg-white/90">
              {t("passage.banner.action")}
            </button>
            <button
              type="button"
              onClick={() => {
                passageFlags.closeBanner();
                setClosed(true);
              }}
              aria-label={t("passage.banner.close")}
              className="flex h-8 w-8 items-center justify-center text-subtle hover:text-white"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      {open && <PassageDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
