"use client";

import { Download, Check, CalendarClock } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import type { MissingSeason } from "@/app/api/player/series/[sonarrId]/missing/route";

/**
 * Ce qui manque à une saison, et de quoi le demander.
 *
 * L'écran des épisodes se construit à partir de Jellyfin, donc uniquement à partir de ce qu'on
 * possède : un épisode absent n'existait tout simplement pas à l'écran, et une saison entière
 * manquante non plus. On voyait quatre saisons d'une série qui en compte cinq, sans rien qui le
 * dise.
 *
 * La demande n'est pas la même que celle d'un film absent : la série est déjà dans la
 * bibliothèque, il n'y a rien à ajouter. Ce qui manque, ce sont des fichiers — et le geste juste
 * est la recherche automatique de Sonarr, sur l'épisode ou la saison désignés. Personne ici n'a à
 * savoir ça : le bouton dit « Demander », comme partout ailleurs.
 *
 * Un épisode qui n'est pas encore diffusé garde son bouton, éteint, avec sa date : le supprimer
 * laisserait croire que la série s'arrête là.
 */
export function CinemaMissingEpisodes({
  season,
  asked,
  busy,
  onRequestSeason,
  onRequestEpisode,
}: {
  season: MissingSeason | undefined;
  asked: Set<string>;
  busy: boolean;
  onRequestSeason: (seasonNumber: number) => void;
  onRequestEpisode: (episodeId: number, label: string) => void;
}) {
  const t = useT();
  if (!season || season.episodes.length === 0) return null;

  const seasonAsked = asked.has(`s${season.seasonNumber}`);
  const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-white/80">
          {t("cinema.missing.count", { n: season.episodes.length })}
        </p>
        {season.requestable && (
          <button
            type="button"
            disabled={busy || seasonAsked}
            onClick={() => onRequestSeason(season.seasonNumber)}
            className="btn btn-sm btn-primary shrink-0 disabled:opacity-60"
          >
            {seasonAsked ? <Check size={14} /> : <Download size={14} />}
            {seasonAsked ? t("cinema.missing.requested") : t("cinema.missing.requestSeason")}
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {season.episodes.map((ep) => {
          const episodeAsked = asked.has(`e${ep.id}`) || seasonAsked;
          const label = `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`;
          const airs = ep.airDate ? dateFormat.format(new Date(ep.airDate)) : null;
          return (
            <li key={ep.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <span className="w-14 shrink-0 font-mono text-xs text-white/40">{label}</span>
              {/* La date de diffusion se lit partout, y compris sur téléphone où elle était
                  masquée faute de largeur. Sur une saison en cours, c'est la seule information
                  qui répond à la question qu'on se pose vraiment : quand ?

                  Elle passe donc sous le titre quand la place manque, au lieu de disparaître —
                  et elle est mise en avant sur ce qui n'est pas encore sorti, où « Pas encore
                  diffusé » ne disait pas la moitié de ce qu'on voulait savoir. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="min-w-0 truncate text-sm text-white/70">{ep.title}</span>
                {airs && (
                  <span
                    className={`shrink-0 text-xs ${ep.released ? "text-white/35" : "text-accent-300/80"} sm:ml-auto`}
                  >
                    {ep.released ? airs : t("cinema.missing.airsOn", { date: airs })}
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={!ep.released || busy || episodeAsked}
                onClick={() => onRequestEpisode(ep.id, label)}
                title={ep.released ? undefined : t("cinema.missing.notAired")}
                className="btn btn-ghost btn-sm shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {episodeAsked ? (
                  <>
                    <Check size={13} /> {t("cinema.missing.requested")}
                  </>
                ) : ep.released ? (
                  <>
                    <Download size={13} /> {t("player.discover.request")}
                  </>
                ) : (
                  <>
                    <CalendarClock size={13} /> {t("cinema.missing.notAiredShort")}
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
