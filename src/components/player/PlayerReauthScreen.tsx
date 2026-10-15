"use client";

import { useEffect } from "react";
import { useT } from "@/components/TranslationProvider";

/**
 * « Ta session Jellyfin a expiré » — l'écran du lecteur quand Jellyfin refuse le jeton du compte.
 *
 * Il remplaçait tout le lecteur, commandes comprises, par un paragraphe et un lien : ni croix, ni
 * Échap, ni retour (l'adresse changeait, l'écran restait par-dessus tout). Seuls un rechargement ou
 * la reconnexion en sortaient — et la reconnexion ramenait à l'accueil, `next` ne portant que le
 * chemin (passe de nuit du 15/10/2026, BUREAU-22). « Quitter » referme le lecteur par le même chemin
 * que l'écran d'erreur ordinaire, Échap aussi quand le lecteur occupe l'écran (pas en mini-lecteur,
 * où Échap appartient à l'écran qu'on parcourt), et `next` garde le fragment : on revient à la fiche
 * (`safeNextPath` le rend tel quel).
 */
export function PlayerReauthScreen({ onClose, keyboard }: { onClose: () => void; keyboard: boolean }) {
  const t = useT();

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, onClose]);

  const here = window.location.pathname + window.location.search + window.location.hash;

  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <p className="mb-4 text-sm text-white">{t("player.sessionExpired")}</p>
        <div className="flex justify-center gap-3">
          <button type="button" onClick={onClose} className="btn btn-ghost px-4 py-2">
            {t("player.quit")}
          </button>
          <a href={`/login?reason=playback&next=${encodeURIComponent(here)}`} className="btn-primary inline-flex justify-center">
            {t("player.reconnect")}
          </a>
        </div>
      </div>
    </div>
  );
}
