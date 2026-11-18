"use client";

import { CalendarClock } from "lucide-react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlayerSeriesRequests } from "@/lib/usePlayerSeriesRequests";
import { nextAiring, nextAiringWhen } from "@/lib/nextAiring";
import { useMinuteNow } from "@/lib/useMinuteNow";

/**
 * « Prochain épisode jeudi · S3:É6 », sous le bouton Lecture d'une série dont tout ce qui est sorti a été vu
 * (`nextAiring.ts`). Une ligne d'information, discrète, sans bouton ; rien quand aucune date n'est annoncée.
 * La liste lue est celle de l'écran des épisodes (même clé) : demandée seulement quand la ligne a lieu d'être.
 */

const noSubscribe = () => () => {};

export function CinemaNextAiring({ sonarrId, show, className = "" }: { sonarrId: number | null | undefined; show: boolean; className?: string }) {
  const t = useT();
  const { locale } = useLocale();
  const { seasons } = usePlayerSeriesRequests(show ? sonarrId : null);
  // Lue au rendu, sans minuterie : une fiche ne reste pas ouverte d'un jour sur l'autre.
  const now = useMinuteNow(noSubscribe);
  if (!show || now === 0) return null;
  const next = nextAiring(seasons, now);
  if (!next) return null;
  const when = nextAiringWhen(next.at, now, locale);
  const whenText =
    when.kind === "today" ? t("cinema.nextAiring.today") : when.kind === "tomorrow" ? t("cinema.nextAiring.tomorrow") : when.kind === "weekday" ? t("cinema.nextAiring.weekday", { day: when.text }) : t("cinema.missing.airsOn", { date: when.text });
  return (
    <p data-next-airing="" className={`flex items-center gap-2 text-sm text-muted ${className}`}>
      <CalendarClock size={15} aria-hidden className="shrink-0" />
      <span>
        {t("cinema.nextAiring.label", { when: whenText })}
        <span className="text-subtle"> · {t("cinema.episodeShort", { season: next.seasonNumber, episode: next.episodeNumber })}</span>
      </span>
    </p>
  );
}
