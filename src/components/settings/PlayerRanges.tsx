"use client";

import { useT } from "@/components/TranslationProvider";

/**
 * Les lecteurs de Laterna, en tête de Configuration → Lecture (DECISIONS.md §194, 17/11/2026) : ce que chacun fait, sur
 * quels appareils, et ce qu'il demande au serveur. Un texte fixe — les réglages sont dans les cartes qui suivent ; ce
 * bloc dit seulement qui est qui, pour qu'un exploitant sache quoi allumer selon son matériel.
 */
const RANGES = ["current", "server", "lumen", "lumenAudio", "lumenLight", "offline", "cast"] as const;

export function PlayerRanges() {
  const t = useT();
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-player-ranges="">
      <h2 className="text-base font-semibold text-white">{t("config.players.title")}</h2>
      <p className="mb-3 mt-1 text-sm text-muted">{t("config.players.intro")}</p>
      <ul className="space-y-2.5">
        {RANGES.map((id) => (
          <li key={id} className="text-sm">
            <span className="font-medium text-white">{t(`config.players.${id}.name`)}</span>
            <span className="text-muted"> — {t(`config.players.${id}.what`)}</span>
            <span className="block text-xs text-subtle">{t("config.prereq", { text: t(`config.players.${id}.needs`) })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
