"use client";

import { armScrollProbe, disarmScrollProbe, useScrollProbeState } from "@/lib/scrollProbe";

/**
 * Lot T — fluidité de la grille (13/10/2026). La mesure de 20 s (`scrollProbe.ts`) a trouvé l'à-coup
 * de « Tous les films » sur l'iPhone, là où quatre interrupteurs d'essai (filtres, fondu,
 * préchargement, barre) n'avaient rien changé ; ils sont retirés, la mesure reste.
 */
export function SmoothnessLot() {
  const probe = useScrollProbeState();
  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        L&apos;à-coup de « Tous les films » venait de la grille d&apos;un seul tenant : une rangée affichée ou mise de côté recalculait les huit cents cartes (120 à 133 ms sur iPhone) ; la grille est en paquets depuis la 8.53.4. La mesure reste là pour vérifier une grille sur l&apos;appareil qu&apos;on tient.
      </p>
      {/* La mesure : armée ici, elle démarre au premier défilement de la grille et s'envoie seule. */}
      <div className="flex items-start justify-between gap-4">
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
