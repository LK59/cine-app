"use client";

import { useEffect, useState } from "react";
import { Wrench, AlertTriangle, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { usePlayback } from "@/components/PlaybackProvider";
import { useMaintenance } from "@/lib/useMaintenance";

/** Le dernier avis que *cet* écran a déjà montré, pour ne pas le remontrer à chaque sondage. */
const SEEN_KEY = "cine:maintenance-notice-seen";

/**
 * Combien de temps l'avis reste sur le film.
 *
 * Il se referme tout seul : personne ne veut redécouvrir une fenêtre d'avertissement en revenant
 * d'une pause de vingt minutes, et un avis de redémarrage imminent qui n'est plus imminent est
 * devenu du décor.
 */
const NOTICE_MS = 30_000;

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    // Stockage indisponible — l'avis se réaffichera au prochain chargement, ce qui est le bon
    // sens de l'erreur pour un avertissement.
    return 0;
  }
}

function markSeen(at: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    /* voir readSeen */
  }
}

/**
 * Ce que l'exploitation dit aux spectateurs : un bandeau qui dure, un avis qui passe.
 *
 * Les deux vivent ici plutôt que dans les lecteurs, pour la raison qui revient partout dans ce
 * dépôt : la même décision prise à deux endroits diverge. Il y a deux lecteurs — le natif et celui
 * du serveur — et deux interfaces — cinéma et gestion ; monté une fois sous `PlaybackProvider`,
 * ce composant les couvre tous les quatre et sait, par la séance, lequel joue.
 */
export function MaintenanceNotices() {
  const t = useT();
  const { active, noticeAt } = useMaintenance();
  const { session, mode } = usePlayback();
  const [dismissedBanner, setDismissedBanner] = useState(false);
  /** L'avis que ce spectateur a écarté — par le bouton, ou par le temps qui passe. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /**
   * Ce que cet écran avait déjà vu en arrivant, lu une seule fois.
   *
   * Lu à l'initialisation plutôt que dans un effet, ce qui rend l'avis *dérivé* du rendu au lieu
   * d'être un état posé par un effet — c'est ce que la règle `set-state-in-effect` demande, et
   * ici ça se trouve être aussi la formulation la plus simple. La valeur reste volontairement
   * figée pour la vie du montage : ce qui masque un avis déjà montré n'est pas elle, c'est
   * `dismissed`. Au prochain chargement, le stockage aura la date et l'avis ne reviendra pas.
   */
  const [seenOnArrival] = useState(readSeen);

  // Un avis plus récent que ce que cet écran avait déjà vu. Comparé à une date et non à un
  // booléen : c'est ce qui permet d'avertir deux fois sans jamais réafficher le premier avis.
  const fresh = noticeAt !== null && noticeAt > seenOnArrival;
  // L'avis ne vise que les écrans qui jouent quelque chose — plein écran ou mini-lecteur. Ailleurs,
  // le bandeau dit déjà ce qu'il y a à dire.
  const showNotice = fresh && dismissed !== noticeAt && !!session;
  // Le bandeau se tait pendant qu'un film occupe tout l'écran : il s'y poserait par-dessus
  // l'image pour la durée du film. C'est précisément le cas que l'avis ci-dessus couvre, et
  // lui sait repartir.
  const showBanner = active && !dismissedBanner && mode !== "full";

  // Deux effets de bord, aucun `setState` direct : on note au stockage que cet avis a été montré,
  // et on arme sa fermeture. Le `setDismissed` vit dans le rappel du minuteur, pas dans le corps.
  useEffect(() => {
    if (!showNotice || noticeAt === null) return;
    markSeen(noticeAt);
    const id = setTimeout(() => setDismissed(noticeAt), NOTICE_MS);
    return () => clearTimeout(id);
  }, [showNotice, noticeAt]);

  return (
    <>
      {showBanner && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-[65] flex justify-center px-3"
          style={{ paddingTop: "max(env(safe-area-inset-top), 0.75rem)" }}
        >
          <div className="glass-panel pointer-events-auto flex max-w-xl items-start gap-3 rounded-2xl border border-amber-400/30 px-4 py-2.5 shadow-glow">
            <Wrench size={15} className="mt-0.5 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-amber-100">{t("maintenance.bannerTitle")}</p>
              <p className="mt-0.5 text-xs leading-snug text-slate-300">{t("maintenance.bannerText")}</p>
            </div>
            <button
              type="button"
              onClick={() => setDismissedBanner(true)}
              className="mt-0.5 shrink-0 text-slate-400 transition-colors hover:text-slate-200"
              aria-label={t("common.close")}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {showNotice && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex justify-center px-3 pt-[max(env(safe-area-inset-top),1rem)]">
          <div className="glass-panel pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl border border-amber-400/50 px-4 py-3 shadow-glow animate-fade-in">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-100">{t("maintenance.noticeTitle")}</p>
              <p className="mt-1 text-xs leading-snug text-slate-200">{t("maintenance.noticeText")}</p>
            </div>
            <button
              type="button"
              onClick={() => setDismissed(noticeAt)}
              className="mt-0.5 shrink-0 text-slate-400 transition-colors hover:text-slate-200"
              aria-label={t("common.close")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
