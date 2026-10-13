"use client";

import { Toggle } from "@/components/Toggle";
import { setLabFlag, useLabFlags, type LabFlag } from "@/lib/labFlags";
import { armScrollProbe, disarmScrollProbe, useScrollProbeState } from "@/lib/scrollProbe";

/**
 * Lot T — essais de fluidité de « Tous les films » (13/10/2026). Chaque interrupteur retire un
 * suspect de l'à-coup qui marque la remontée de la grille au moment où la rangée des filtres
 * reparaît ; l'essai se fait dans la vraie grille, sur l'appareil qu'on tient. Voir `labFlags.ts`.
 */
const TRIALS: { flag: LabFlag; title: string; hint: string }[] = [
  {
    flag: "filtersNoScroll",
    title: "Rangée des filtres sans défilement horizontal",
    hint: "Les menus passent à la ligne au lieu de défiler. Si l'à-coup disparaît, c'est la petite zone qui défile dans la grande.",
  },
  {
    flag: "noHeaderFade",
    title: "Sans le fondu sous l'en-tête",
    hint: "Le contenu est coupé net sous le titre. Dit aussi si le liseré vient du fondu.",
  },
  {
    flag: "noDecodeAhead",
    title: "Sans préchargement des affiches",
    hint: "La grille ne suit plus ses cartes : les affiches peuvent arriver en retard, c'est attendu pendant l'essai.",
  },
];

export function SmoothnessLot() {
  const flags = useLabFlags();
  const probe = useScrollProbeState();
  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        Un interrupteur à la fois, puis « Tous les films » et un glissé lent vers le haut jusqu&apos;aux filtres. Les réglages restent sur cet appareil seulement : pensez à tout éteindre après l&apos;essai.
      </p>
      <ul className="divide-y divide-white/8">
        {TRIALS.map((trial) => (
          <li key={trial.flag} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="text-sm text-white">{trial.title}</p>
              <p className="mt-0.5 text-xs text-subtle">{trial.hint}</p>
            </div>
            <Toggle checked={flags[trial.flag]} ariaLabel={trial.title} onChange={(next) => setLabFlag(trial.flag, next)} />
          </li>
        ))}
      </ul>
      {/* La mesure : armée ici, elle démarre au premier défilement de la grille et s'envoie seule. */}
      <div className="flex items-start justify-between gap-4 border-t border-white/8 pt-3">
        <div className="min-w-0">
          <p className="text-sm text-white">Mesure de 20 secondes</p>
          <p className="mt-0.5 text-xs text-subtle">
            {probe === "armed"
              ? "Armée : ouvrez « Tous les films » et faites votre glissé. L'enregistrement démarre au premier mouvement."
              : probe === "recording"
                ? "Enregistrement en cours…"
                : probe === "sent"
                  ? "Envoyée au journal. Vous pouvez la réarmer pour un autre essai."
                  : "Relève chaque image pendant 20 s dans la grille et l'envoie au journal."}
          </p>
        </div>
        {probe === "armed" ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={disarmScrollProbe}>
            Annuler
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" disabled={probe === "recording"} onClick={armScrollProbe}>
            Armer
          </button>
        )}
      </div>
    </section>
  );
}
