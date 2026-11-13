"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { AudioLines, Captions, Info, Monitor, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { ROUND_ACTION } from "@/components/cinema/roundAction";
import { useLocale, useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { labelAudioTracks, languageName, subtitleKind } from "@/lib/trackLabel";
import { isAudioDescription, trackLanguage } from "@/lib/trackPreferences";
import { advisedConnectionMbps, bitrateMbps, definitionLabel, openingAudioIndex, videoCodecLabel } from "@/lib/titleDetails";
import type { FileStreamsResponse, FileStreamTrack } from "@/app/api/jellyfin/streams/[itemId]/route";
import type { PlaybackState } from "@/app/api/jellyfin/playback-state/[itemId]/route";
import type { CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

type Translate = ReturnType<typeof useT>;

/**
 * La fenêtre « Détails » d'un film ou d'un épisode (DECISIONS.md §152, 13/11/2026) : ce que contient son
 * fichier, dit pour tout le monde — l'image, le son, les sous-titres. Une série n'a pas un fichier mais des
 * centaines : sa fiche n'a pas l'entrée, chacune de ses lignes d'épisode a la sienne (`EpisodeDetailsButton`).
 * Rien en partage (`ShareTitleSheet` ne l'appelle pas, et `shareGate` ne laisse pas passer sa route).
 *
 * **Pas dans l'adresse**, comme les autres fenêtres posées sur une fiche (Partager, Télécharger, Poser
 * une question) : l'adresse dit quel écran est ouvert, pas ce qu'on regarde dessus. C'est une feuille
 * (`ActionSheet`) : Échap, un appui sur le fond, sa croix ou le glisser vers le bas — depuis n'importe où
 * hors du contenu qui défile, l'en-tête et l'image toujours (Louis, 13/11/2026) — la referment, et la
 * fiche dessous se tait tant qu'elle est là (`sheetKeyBelongsElsewhere`, §117.1). Refermée, elle n'écoute
 * plus rien pendant qu'elle redescend (règle 2 des fiches).
 *
 * Les données ne sont demandées **qu'à l'ouverture** (`/api/jellyfin/streams/<id>`, et les préférences du
 * compte par `playback-state`, pour « Par défaut ») — rien de plus au chargement d'une fiche — et gardées
 * pour la descente : la clé SWR reste posée une fois demandée pour ce titre, sans quoi la fenêtre se
 * viderait sous les yeux en se refermant.
 */
export function TitleDetailsSheet({
  open,
  onClose,
  itemId,
  tmdbId,
  title,
  logoUrl,
  episode,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
  tmdbId?: number | null;
  /** Le titre du film — ou de la série, pour un épisode. */
  title: string;
  /** Le logo du film — ou de la série, pour un épisode. */
  logoUrl?: string | null;
  /** Un épisode : « S1 · É3 — Son titre » sous le logo de la série. */
  episode?: { season: number; number: number; title: string };
}) {
  const t = useT();
  const { locale } = useLocale();
  // Le titre pour lequel la fenêtre a été ouverte. Ajusté pendant le rendu, la forme que le compilateur
  // accepte : une fiche réutilisée pour un autre film (titres similaires) ne redemande rien tant qu'on
  // n'ouvre pas sa fenêtre à lui.
  const [askedFor, setAskedFor] = useState<string | null>(null);
  if (open && askedFor !== itemId) setAskedFor(itemId);
  const url = `/api/jellyfin/streams/${encodeURIComponent(itemId)}${tmdbId ? `?tmdb=${tmdbId}` : ""}`;
  const { data, error } = useSWR<FileStreamsResponse>(askedFor === itemId ? url : null, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  // Les préférences du compte, d'où le lecteur les prend (`playback-state` : la langue du son, celle retenue
  // pour la série, `playDefaultAudioTrack`) — à l'ouverture seulement, comme le reste. Une erreur laisse le
  // drapeau du fichier, ce que le lecteur ferait sans préférences.
  const { data: state, error: stateError } = useSWR<PlaybackState>(
    askedFor === itemId ? `/api/jellyfin/playback-state/${encodeURIComponent(itemId)}` : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const preferencesKnown = state !== undefined || stateError !== undefined;
  const opening = data && preferencesKnown ? openingAudioIndex(data.audio, state?.preferences ?? null) : null;

  return (
    <ActionSheet open={open} onClose={onClose} actions={[]} centerOnWide ariaLabel={t("cinema.details.title")}>
      {/* En grand, la poignée de l'`ActionSheet` est masquée (fenêtre centrée) : l'en-tête reprend l'espace qu'elle
          laissait au-dessus du logo, sans quoi il touchait le bord haut (13/11/2026). */}
      <div data-title-details="" className="relative px-5 pb-3 sm:pt-5">
        <div className="flex min-h-10 items-center pr-12">
          {logoUrl ? (
            <CinemaLogo src={logoUrl} alt={title} surface="player" shadow={false} fallback={<WrittenTitle title={title} />} />
          ) : (
            <WrittenTitle title={title} />
          )}
        </div>
        {episode && (
          <p data-details-episode="" className="mt-2 line-clamp-2 pr-12 text-sm font-medium leading-snug text-white">
            {t("cinema.episodeShort", { season: episode.season, episode: episode.number })} — {episode.title}
          </p>
        )}
        {/* `data-sheet-action` : c'est elle qui reçoit le focus à l'ouverture (`ActionSheet`), comme la
            première action d'une feuille — sans quoi il restait sur le rond « i », derrière. En grand (fenêtre
            centrée, sans poignée), à la même distance du bord haut que du bord droit (Louis, 13/11/2026) : elle
            touchait le haut. */}
        <button
          type="button"
          data-sheet-action=""
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-4 top-0 flex h-9 w-9 sm:top-4 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:bg-white focus-visible:text-ink focus-visible:outline-none"
        >
          <X size={18} />
        </button>
      </div>
      {/* L'image hors du défilement (13/11/2026) : avec l'en-tête, c'est le haut de la feuille qui se tire
          toujours au doigt, même quand le reste défile — la poignée seule était trop petite à attraper. */}
      {data && !error && (
        <div className="px-4 pb-3">
          <PictureBlock data={data} locale={locale} t={t} />
        </div>
      )}
      <DetailsScroller>
        {error ? (
          <p data-details-error="" className="rounded-2xl bg-white/[0.06] px-4 py-5 text-center text-sm text-muted">
            {t(episode ? "cinema.details.unavailableEpisode" : "cinema.details.unavailable")}
          </p>
        ) : !data ? (
          <DetailsSkeleton label={t("common.loading")} />
        ) : (
          <>
            <SoundBlock data={data} locale={locale} t={t} opening={opening} />
            <SubtitlesBlock data={data} locale={locale} t={t} />
          </>
        )}
      </DetailsScroller>
    </ActionSheet>
  );
}

function WrittenTitle({ title }: { title: string }) {
  return <h2 className="line-clamp-2 text-xl font-semibold leading-tight text-white">{title}</h2>;
}

function DetailsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.06]" />
      ))}
    </div>
  );
}

function Block({ icon, title, children, name }: { icon: ReactNode; title: string; children: ReactNode; name: string }) {
  return (
    <section data-details-block={name} className="rounded-2xl border border-white/8 bg-white/[0.06] px-4 py-3.5">
      <h3 className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Une étiquette. **Jamais l'or** de la marque (`design-tokens.test.ts`) : il dit ce qui est « à moi » (vu,
 * dans ma liste) ; la piste qu'ouvrira le lecteur ne l'est pas. Elle se détache en blanc (`strong`).
 */
function Tag({ children, tone = "plain", mark }: { children: ReactNode; tone?: "plain" | "strong"; mark?: string }) {
  return (
    <span
      data-details-tag={mark}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight ${
        tone === "strong" ? "bg-white/20 text-white" : "bg-white/10 text-muted"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Le son et les sous-titres, qui défilent seuls quand ils dépassent (six pistes son, vingt langues de
 * sous-titres).
 *
 * La feuille refuse tout geste du navigateur (`touch-action: none`) et se tire au doigt depuis n'importe
 * où (`ActionSheet`) ; ici, **seulement quand le contenu dépasse**, le défilement vertical revient au
 * navigateur (`pan-y`) et la feuille ne se tire plus depuis cette zone (`data-sheet-scroll`, lu par
 * `ActionSheet` à l'appui). Un contenu qui tient garde `none` : le navigateur ne s'approprie pas un
 * glissement qui n'a rien à faire défiler, et tout le bas de la feuille la tire aussi (13/11/2026).
 * Mesuré à chaque changement de taille, pas à l'appui : le navigateur lit `touch-action` avant que le
 * premier événement n'arrive.
 */
function DetailsScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOverflows(el.scrollHeight > el.clientHeight + 1));
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div
      ref={ref}
      data-sheet-scroll=""
      className="max-h-[min(48svh,24rem)] space-y-3 overflow-y-auto overscroll-contain px-4 pb-2"
      style={{ touchAction: overflows ? "pan-y" : "none" }}
    >
      {children}
    </div>
  );
}

function PictureBlock({ data, locale, t }: { data: FileStreamsResponse; locale: string; t: Translate }) {
  const video = data.video;
  const definition = video ? definitionLabel(video.width, video.height) : null;
  // SDR ne se dit pas : c'est l'ordinaire, comme le 1080p des pastilles (`videoQuality.ts`).
  const dynamic = video?.dynamicRange && video.dynamicRange !== "SDR" ? video.dynamicRange : null;
  const codec = video ? videoCodecLabel(video.codec, video.bitDepth, (n) => t("cinema.details.bits", { n })) : null;
  const dvProfile = dynamic === "Dolby Vision" && video?.dvProfile ? t("cinema.details.dvProfile", { n: video.dvProfile }) : null;
  const mbps = bitrateMbps(data.bitrate);
  const advised = advisedConnectionMbps(data.bitrate);
  const number = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
  if (!definition && !dynamic && !codec && mbps === null) return null;
  return (
    <Block name="image" icon={<Monitor size={13} />} title={t("cinema.details.picture")}>
      {(definition || dynamic) && (
        <p className="flex flex-wrap items-baseline gap-x-3 text-2xl font-semibold leading-tight text-white">
          {definition && <span data-details-definition="">{definition}</span>}
          {dynamic && (
            <span data-details-dynamic="" className="text-white">
              {dynamic}
            </span>
          )}
        </p>
      )}
      {(codec || dvProfile) && <p className="mt-1 text-sm text-muted">{[codec, dvProfile].filter(Boolean).join(" · ")}</p>}
      {mbps !== null && (
        <div data-details-bitrate="" className="mt-3 rounded-xl bg-black/25 px-3 py-2.5">
          <p className="text-sm font-medium text-white">{t("cinema.details.bitrate", { rate: t("cinema.details.mbps", { n: number(mbps) }) })}</p>
          {advised !== null && (
            <p className="mt-0.5 text-xs leading-snug text-muted">
              {t("cinema.details.advised", { rate: t("cinema.details.mbps", { n: number(advised) }) })}
            </p>
          )}
        </div>
      )}
    </Block>
  );
}

/**
 * « Dolby TrueHD + Dolby Atmos », tel que Jellyfin l'a lu dans le fichier — ou, sans profil, tel que le
 * titre de la piste le dit. Affiché sous l'étiquette, sans réserve ni promesse (Louis, 13/11/2026) : c'est
 * ce que le fichier déclare ; ce que la lecture fait du son, le panneau technique du lecteur le dit.
 */
function declaredAtmos(track: FileStreamTrack): string | null {
  if (track.profile && /atmos/i.test(track.profile)) return track.profile;
  return track.atmos ? "Dolby Atmos" : null;
}

/**
 * `opening` : le rang de la piste que le lecteur ouvrira pour ce compte (`openingAudioIndex`), marquée « Par
 * défaut » — `null` tant que les préférences du compte ne sont pas lues, pour ne pas déplacer l'étiquette
 * sous les yeux.
 */
function SoundBlock({ data, locale, t, opening }: { data: FileStreamsResponse; locale: string; t: Translate; opening: number | null }) {
  // Les étiquettes des menus du lecteur, par la même fonction et les mêmes mots (`trackLabel.ts`) : un
  // titre ne se décrit jamais de deux façons.
  const labels = labelAudioTracks(
    data.audio.map((a, i) => ({
      number: a.index ?? i,
      language: a.language,
      name: a.name ?? a.title,
      isDefault: a.isDefault,
      isForced: false,
      codecId: a.codec,
      channels: a.channels,
      profile: a.profile ?? null,
    })),
    {
      locale,
      originalLanguage: data.originalLanguage ?? null,
      canaux: (n) => t("player.trackLabel.channels", { n }),
      piste: (n) => t("player.trackLabel.track", { n }),
    }
  );
  return (
    <Block name="son" icon={<AudioLines size={13} />} title={t("cinema.details.sound")}>
      {data.audio.length === 0 ? (
        <p className="text-sm text-muted">{t("cinema.details.noAudio")}</p>
      ) : (
        <ul className="space-y-2">
          {data.audio.map((a, i) => {
            const atmos = declaredAtmos(a);
            const described = isAudioDescription({ language: a.language, name: a.name ?? a.title, isDefault: a.isDefault, isForced: false });
            const chosen = opening === i;
            return (
              <li key={a.index ?? i} data-details-audio="" className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm leading-snug text-white">{labels[i]?.label}</p>
                  {atmos && (
                    <p data-details-atmos="" className="text-xs leading-snug text-muted">
                      {atmos}
                    </p>
                  )}
                </div>
                {(chosen || described) && (
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {chosen && (
                      <Tag tone="strong" mark="default">
                        {t("cinema.details.default")}
                      </Tag>
                    )}
                    {described && <Tag>{t("cinema.details.audioDescription")}</Tag>}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

/**
 * Les sous-titres regroupés par langue, dans l'ordre du fichier, le type en étiquette — « Complets »,
 * « Forcés », « Malentendants », par la décision des menus (`subtitleKind`). Une piste que Laterna a fait
 * générer le dit ; une piste posée à côté du film, non (« fichier à part » retiré le 13/11/2026, Louis :
 * c'est de l'infrastructure, pas ce que voit le spectateur). Deux pistes de même étiquette se comptent
 * (« Complets ×2 ») au lieu de se répéter. Exportée pour ses tests.
 */
export function subtitleGroups(
  subtitles: readonly FileStreamTrack[],
  locale: string,
  t: Translate
): { language: string; tags: { text: string; count: number }[] }[] {
  const groups = new Map<string, { language: string; tags: Map<string, number> }>();
  const unknown = t("cinema.details.unknownLanguage");
  for (const s of subtitles) {
    const facts = { language: s.language, name: s.name ?? s.title, isDefault: s.isDefault, isForced: s.forced, isHearingImpaired: s.hearingImpaired };
    const language = languageName(trackLanguage(facts), locale) ?? unknown;
    const kind = subtitleKind(facts);
    const kindText = t(kind === "sdh" ? "cinema.details.subSdh" : kind === "forced" ? "cinema.details.subForced" : "cinema.details.subFull");
    const text = s.generated ? `${kindText} · ${t("cinema.details.subGenerated")}` : kindText;
    const group = groups.get(language) ?? { language, tags: new Map<string, number>() };
    group.tags.set(text, (group.tags.get(text) ?? 0) + 1);
    groups.set(language, group);
  }
  // La langue inconnue en dernier : elle ne dit rien, et ne doit pas passer devant celles qui disent.
  return [...groups.values()]
    .sort((a, b) => Number(a.language === unknown) - Number(b.language === unknown))
    .map((g) => ({ language: g.language, tags: [...g.tags].map(([text, count]) => ({ text, count })) }));
}

function SubtitlesBlock({ data, locale, t }: { data: FileStreamsResponse; locale: string; t: Translate }) {
  const groups = subtitleGroups(data.subtitles, locale, t);
  return (
    <Block name="sous-titres" icon={<Captions size={13} />} title={t("cinema.details.subtitles")}>
      {groups.length === 0 ? (
        <p className="text-sm text-muted">{t("cinema.details.noSubtitles")}</p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li key={g.language} data-details-subtitle="" className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-sm leading-snug text-white">{g.language}</span>
              <span className="flex flex-wrap justify-end gap-1">
                {g.tags.map((tag) => (
                  <Tag key={tag.text}>{tag.count > 1 ? `${tag.text} ×${tag.count}` : tag.text}</Tag>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

/**
 * Le rond « i » de la rangée des fiches du bureau (`DetailIconActions`), avec sa légende « Infos » comme
 * « Vu » et « À voir » (13/11/2026). Le verre des autres ronds (`ROUND_ACTION`) ; `data-detail-menu` : les
 * flèches y descendent comme dans le reste du menu.
 */
export function TitleDetailsRound({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <div data-round-toggle="" className="flex min-w-14 flex-col items-center gap-1">
      <button
        type="button"
        data-detail-menu
        data-round-action="details"
        onClick={onOpen}
        aria-label={t("cinema.details.title")}
        title={t("cinema.details.title")}
        className={ROUND_ACTION}
      >
        <Info size={19} />
      </button>
      <span aria-hidden="true" data-round-caption="" className="whitespace-nowrap text-center text-[11px] leading-tight text-muted">
        {t("cinema.details.caption")}
      </span>
    </div>
  );
}

/**
 * Le petit « i » d'une ligne d'épisode, juste à côté de son téléchargement (Louis, 13/11/2026) : la même
 * fenêtre « Détails », pour le fichier de cet épisode — en tête le logo de la série (son titre écrit à
 * défaut), puis « S1 · É3 — Son titre ». Une pièce pour les deux listes qui la portent, la fiche du
 * téléphone (`CinemaMobileDetail`) et « Plus d'épisodes » du bureau (`CinemaEpisodeBrowser`) : elles ne
 * diffèrent que par la taille, comme le bouton de téléchargement (`OfflineEpisodeButton`), dont il
 * reprend la forme discrète.
 *
 * Rien pour un épisode sans fichier (`fileMissing`, un épisode virtuel de Jellyfin) : rien à décrire. Pas en
 * partage : `ShareTitleSheet` ne passe pas `episodeDetails` à `CinemaEpisodeBrowser`, et la route du fichier
 * n'est pas dans la liste fermée des liens (`shareGate`).
 *
 * La fenêtre n'est montée qu'une fois demandée : une saison de vingt épisodes ne pose pas vingt feuilles.
 */
export function EpisodeDetailsButton({
  episode,
  seriesTitle,
  seriesLogoUrl,
  size,
  className = "",
}: {
  episode: Pick<CinemaEpisode, "jellyfinItemId" | "seasonNumber" | "episodeNumber" | "title" | "fileMissing">;
  seriesTitle: string;
  seriesLogoUrl?: string | null;
  size: "desktop" | "phone";
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  if (episode.fileMissing) return null;
  const box = size === "desktop" ? "h-11 w-11" : "h-10 w-10";
  const label = t("cinema.details.title");
  return (
    <>
      <button
        type="button"
        data-episode-details=""
        aria-label={`${label} — ${episode.episodeNumber}. ${episode.title}`}
        title={label}
        onClick={() => {
          setAsked(true);
          setOpen(true);
        }}
        className={`${box} ${className} flex shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white focus-visible:outline-none active:bg-white/15`}
      >
        <Info size={size === "desktop" ? 20 : 18} />
      </button>
      {asked && (
        <TitleDetailsSheet
          open={open}
          onClose={() => setOpen(false)}
          itemId={episode.jellyfinItemId}
          title={seriesTitle}
          logoUrl={seriesLogoUrl}
          episode={{ season: episode.seasonNumber, number: episode.episodeNumber, title: episode.title }}
        />
      )}
    </>
  );
}
