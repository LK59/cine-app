"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { usePlayback } from "@/components/PlaybackProvider";
import {
  armLinkSimulator,
  deliveredMbps,
  disarmLinkSimulator,
  setSimulatedLink,
  simulatedLink,
  subscribeLinkSimulator,
} from "@/lib/linkSimulator";
import { setSlowLinkMonitor, slowLinkEvents, subscribeSlowLinkMonitor } from "@/lib/slowLinkMonitor";
import { carriedLighter, usePlaybackQuality, writePlaybackQuality } from "@/lib/playbackQuality";
import { diagNeedBps } from "@/lib/webcodecs/playbackDiagnosis";

/**
 * Lot S — la connexion simulée (DECISIONS.md §78). Un film de la bibliothèque, lu dans le VRAI lecteur,
 * sous un débit réglé à la main (bridé dans le navigateur, dans cet onglet seulement) ; à côté, ce que
 * le lecteur en a fait, en direct : indice, préchauffage, bascules, blocages, messages.
 *
 * Le simulateur ne s'arme qu'ici (`armLinkSimulator`, administrateur, onglet courant) et se désarme en
 * quittant le lot : partout ailleurs, la réception est exactement celle d'avant.
 */

/** Le curseur, en échelle logarithmique : 0,2 à 50 Mbit/s. */
const MIN_MBPS = 0.2;
const MAX_MBPS = 50;
const toMbps = (x: number) => Math.round(MIN_MBPS * Math.pow(MAX_MBPS / MIN_MBPS, x) * 100) / 100;
const toSlider = (mbps: number) => Math.log(mbps / MIN_MBPS) / Math.log(MAX_MBPS / MIN_MBPS);

export function LinkSimLot({ movies }: { movies: CinemaMovie[] }) {
  const playback = usePlayback();
  const quality = usePlaybackQuality();
  const [filmId, setFilmId] = useState<string>("");
  const film = movies.find((m) => m.jellyfinItemId === filmId) ?? movies[0] ?? null;
  const sim = useSyncExternalStore(subscribeLinkSimulator, simulatedLink, simulatedLink);
  const events = useSyncExternalStore(subscribeSlowLinkMonitor, slowLinkEvents, slowLinkEvents);
  const [, setTick] = useState(0);

  // Armé tant que le lot est ouvert ; désarmé en le quittant.
  useEffect(() => {
    armLinkSimulator();
    setSlowLinkMonitor(true);
    return () => {
      disarmLinkSimulator();
      setSlowLinkMonitor(false);
    };
  }, []);
  // Le tableau se relit chaque seconde (débit livré, palier, besoin).
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const mbps = sim.bps / 1e6;
  const need = diagNeedBps();
  // La seule mémoire de la version allégée : la règle des deux minutes (§78).
  const step = carriedLighter();
  const last = useMemo(() => [...events].reverse().slice(0, 40), [events]);
  const playing = playback.session?.itemId ?? null;

  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        {"Le vrai lecteur, sur un vrai film, sous un débit réglé à la main. Le bridage ne vaut que dans cet onglet et tant que ce lot est ouvert. Le tableau montre ce que le lecteur en fait : indice, préchauffage, bascule, blocages, messages."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-lg bg-white/10 px-2 py-1.5 text-sm text-white"
          value={film?.jellyfinItemId ?? ""}
          onChange={(e) => setFilmId(e.target.value)}
          aria-label="Film"
        >
          {movies.map((m) => (
            <option key={m.jellyfinItemId} value={m.jellyfinItemId}>
              {m.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="chip chip-on"
          disabled={!film}
          onClick={() => film && playback.play({ itemId: film.jellyfinItemId, title: film.title, resumeAt: 0 })}
        >
          Lire dans le lecteur
        </button>
        <button type="button" className={`chip ${quality === "auto" ? "chip-on" : ""}`} onClick={() => writePlaybackQuality(quality === "auto" ? "original" : "auto")}>
          Qualité : {quality === "auto" ? "Automatique" : "Originale"}
        </button>
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-white">Débit simulé : {mbps.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Mbit/s</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={toSlider(mbps)}
          onChange={(e) => setSimulatedLink({ mbps: toMbps(Number(e.target.value)) })}
          className="w-full"
          aria-label="Débit simulé"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`chip ${sim.cut ? "chip-on" : ""}`} onClick={() => setSimulatedLink({ cut: !sim.cut })}>
          {sim.cut ? "Rétablir le réseau" : "Coupure totale"}
        </button>
        <button type="button" className="chip" onClick={() => setSimulatedLink({ cutForMs: 5000 })}>
          Coupure de 5 s
        </button>
      </div>
      <table className="w-full text-left text-xs text-white/85">
        <tbody>
          <tr><th className="pr-3 font-medium text-white/60">Simulateur</th><td>{sim.active ? "actif (cet onglet)" : "inactif"}</td></tr>
          <tr><th className="pr-3 font-medium text-white/60">Débit livré (5 s)</th><td>{deliveredMbps(5000)} Mbit/s</td></tr>
          <tr><th className="pr-3 font-medium text-white/60">Besoin (lecteur natif)</th><td>{need ? `${(need / 1e6).toFixed(1)} Mbit/s` : "—"}</td></tr>
          <tr><th className="pr-3 font-medium text-white/60">Lecture</th><td>{playing ? (playing === film?.jellyfinItemId ? "ce film" : "un autre titre") : "aucune"}</td></tr>
          <tr><th className="pr-3 font-medium text-white/60">Palier allégé retenu (2 min)</th><td>{step ? `palier ${step.tier} · ${(step.targetBps / 1e6).toFixed(1)} Mbit/s` : "—"}</td></tr>
          <tr><th className="pr-3 font-medium text-white/60">Qualité</th><td>{quality === "auto" ? "Automatique" : "Originale"}</td></tr>
        </tbody>
      </table>
      <div>
        <p className="mb-1 text-xs font-medium text-white/60">Fil (indice, préchauffage, bascules, blocages, messages) — le plus récent en haut</p>
        <ol className="max-h-72 space-y-0.5 overflow-y-auto font-mono text-[11px] text-white/80" data-link-sim-events="">
          {last.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              {new Date(e.at).toLocaleTimeString("fr-FR")} — {e.text}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
