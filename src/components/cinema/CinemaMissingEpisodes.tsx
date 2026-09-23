"use client";

import { useLocale, useT } from "@/components/TranslationProvider";
import type { MissingSeason } from "@/app/api/player/series/[sonarrId]/missing/route";
import { CinemaDownloading } from "@/components/cinema/CinemaDetailExtras";

/**
 * Ce qui manque à une saison, et ce qui va arriver — de l'information, pas de bouton.
 *
 * L'écran des épisodes se construit à partir de Jellyfin, donc uniquement à partir de ce qu'on
 * possède : un épisode absent n'existait tout simplement pas à l'écran, et une saison entière
 * manquante non plus. On voyait quatre saisons d'une série qui en compte cinq, sans rien qui le
 * dise.
 *
 * Il n'y a plus rien à demander d'ici (23/09/2026). Deux boutons proposaient de redemander un
 * épisode ou une saison précise — une recherche Sonarr sur ce seul morceau. Une série se demande
 * en entier, et Sonarr surveille déjà tout ce qui lui manque : pour un épisode que personne ne
 * diffuse plus, la recherche ne trouvait rien, sans le dire, et le bouton passait pour cassé.
 * Reste ce qu'on veut savoir : ce qui manque, ce qui arrive et quand, ce qui est en route.
 */
export function CinemaMissingEpisodes({ season }: { season: MissingSeason | undefined }) {
  const t = useT();
  const { locale } = useLocale();
  if (!season || season.episodes.length === 0) return null;

  const missing = season.episodes.filter((ep) => ep.released).length;
  const upcoming = season.episodes.length - missing;
  // La langue de l'app, pas celle du navigateur : « le Sep 30, 2026 » dans une page en français.
  const dateFormat = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {/* Ce qui manque et ce qui n'est pas encore sorti ne sont pas la même chose. « 10 épisodes
            manquants » pour une saison annoncée, dont aucun épisode n'était diffusé, laissait
            croire à une bibliothèque incomplète (23/09/2026). */}
        <p className="text-sm font-medium text-muted">
          {[
            missing > 0 ? t("cinema.missing.count", { n: missing }) : null,
            upcoming > 0 ? t("cinema.missing.upcoming", { n: upcoming }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <ul className="flex flex-col gap-1">
        {season.episodes.map((ep) => {
          const airs = ep.airDate ? dateFormat.format(new Date(ep.airDate)) : null;
          return (
            <li key={ep.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
              {/* Le code dit comme partout ailleurs (« S2 · É1 », « T2 · E1 » en espagnol). */}
              <span className="w-16 shrink-0 text-xs tabular-nums text-subtle">
                {t("cinema.episodeShort", { season: ep.seasonNumber, episode: ep.episodeNumber })}
              </span>
              {/* La date de diffusion se lit partout, y compris sur téléphone où elle était
                  masquée faute de largeur. Sur une saison en cours, c'est la seule information
                  qui répond à la question qu'on se pose vraiment : quand ?

                  Elle passe donc sous le titre quand la place manque, au lieu de disparaître —
                  et elle est mise en avant sur ce qui n'est pas encore sorti, où « Pas encore
                  diffusé » ne disait pas la moitié de ce qu'on voulait savoir. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="min-w-0 truncate text-sm text-muted">{ep.title}</span>
                {airs && (
                  <span
                    className={`shrink-0 text-xs ${ep.released ? "text-subtle" : "text-accent-400/80"} sm:ml-auto`}
                  >
                    {ep.released ? airs : t("cinema.missing.airsOn", { date: airs })}
                  </span>
                )}
              </span>
              {/* En route : ce qu'on veut savoir, c'est où il en est. */}
              {ep.downloading != null && <CinemaDownloading progress={ep.downloading} className="shrink-0 px-2" />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
