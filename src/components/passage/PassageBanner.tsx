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
 * en haut de l'écran, « CineApp devient Laterna — Y aller », avec ce que le passage emporte.
 *
 * Seulement quand l'installation annonce une nouvelle adresse (`GET /api/passage`, tiré du réglage
 * du déploiement), jamais sur la nouvelle elle-même (l'hôte de la page comparé à celui de la
 * destination), jamais pendant un film (le lecteur ouvert, plein écran ou réduit) ni par-dessus
 * l'écran d'accueil d'un premier lancement. Refermé — à la croix ou après « Y aller » —, il revient au
 * lancement suivant : la fermeture ne vit que dans la page (souhait du propriétaire, 24/10/2026 ; une
 * fois par jour, la veille, laissait l'ancienne adresse ouverte des jours sans insister). Les clés
 * de fermeture des 10.0.x sont effacées (`passageFlags.forgetBannerClosed`).
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
  const [closed, setClosed] = useState(false);
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
    passageFlags.forgetBannerClosed();
  }, []);

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
          <div role="region" aria-label={t("passage.banner.text")} data-passage-banner="" className="glass-panel pointer-events-auto flex items-center gap-3 rounded-2xl py-2 pl-4 pr-1 shadow-glow">
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-[13px] font-semibold text-white">{t("passage.banner.text")}</span>
              <span className="text-[11px] text-white/70">{t("passage.banner.detail")}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                // « Y aller » vaut une fermeture pour ce lancement : la fenêtre refermée, le bandeau ne
                // revient qu'au suivant.
                setClosed(true);
                setOpen(true);
              }}
              data-passage-open="" className="shrink-0 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-black hover:bg-white/90">
              {t("passage.banner.action")}
            </button>
            <button
              type="button"
              onClick={() => setClosed(true)}
              aria-label={t("passage.banner.close")}
              className="flex h-8 w-8 shrink-0 items-center justify-center text-subtle hover:text-white"
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
