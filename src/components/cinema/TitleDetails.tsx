"use client";

import { useState, type ReactNode } from "react";
import useSWR from "swr";
import { AudioLines, Captions, Info, Monitor, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { ROUND_ACTION } from "@/components/cinema/roundAction";
import { useLocale, useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { labelAudioTracks, languageName, subtitleKind } from "@/lib/trackLabel";
import { isAudioDescription, trackLanguage } from "@/lib/trackPreferences";
import { advisedConnectionMbps, bitrateMbps, definitionLabel, videoCodecLabel } from "@/lib/titleDetails";
import type { FileStreamsResponse, FileStreamTrack } from "@/app/api/jellyfin/streams/[itemId]/route";

type Translate = ReturnType<typeof useT>;

/**
 * La fenêtre « Détails » d'un film (DECISIONS.md §152, 13/11/2026) : ce que contient son fichier, dit
 * pour tout le monde — l'image, le son, les sous-titres. Films seulement : une série n'a pas un fichier
 * mais des centaines, et l'entrée n'existe pas sur sa fiche. Rien en partage (`ShareTitleSheet` ne
 * l'appelle pas, et `shareGate` ne laisse pas passer sa route).
 *
 * **Pas dans l'adresse**, comme les autres fenêtres posées sur une fiche (Partager, Télécharger, Poser
 * une question) : l'adresse dit quel écran est ouvert, pas ce qu'on regarde dessus. C'est une feuille
 * (`ActionSheet`) : Échap, un appui sur le fond, sa croix ou le glisser vers le bas la referment, et la
 * fiche dessous se tait tant qu'elle est là (`sheetKeyBelongsElsewhere`, §117.1). Refermée, elle n'écoute
 * plus rien pendant qu'elle redescend (règle 2 des fiches).
 *
 * Les données ne sont demandées **qu'à l'ouverture** (`/api/jellyfin/streams/<id>`) — rien de plus au
 * chargement d'une fiche — et gardées pour la descente : la clé SWR reste posée une fois demandée pour ce
 * titre, sans quoi la fenêtre se viderait sous les yeux en se refermant.
 */
export function TitleDetailsSheet({
  open,
  onClose,
  itemId,
  tmdbId,
  title,
  logoUrl,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
  tmdbId?: number | null;
  title: string;
  logoUrl?: string | null;
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

  return (
    <ActionSheet open={open} onClose={onClose} actions={[]} centerOnWide ariaLabel={t("cinema.details.title")}>
      <div data-title-details="" className="relative px-5 pb-3">
        <div className="flex min-h-10 items-center pr-12">
          {logoUrl ? (
            <CinemaLogo src={logoUrl} alt={title} surface="player" shadow={false} fallback={<WrittenTitle title={title} />} />
          ) : (
            <WrittenTitle title={title} />
          )}
        </div>
        {/* `data-sheet-action` : c'est elle qui reçoit le focus à l'ouverture (`ActionSheet`), comme la
            première action d'une feuille — sans quoi il restait sur le rond « i », derrière. */}
        <button
          type="button"
          data-sheet-action=""
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-4 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:bg-white focus-visible:text-ink focus-visible:outline-none"
        >
          <X size={18} />
        </button>
      </div>
      {/* Le contenu défile seul quand il dépasse (six pistes son, vingt langues de sous-titres) : la
          feuille, elle, refuse tout geste du navigateur (`touch-action: none`) ; ici le défilement
          vertical lui revient. */}
      <div className="max-h-[min(68svh,34rem)] space-y-3 overflow-y-auto overscroll-contain px-4 pb-2" style={{ touchAction: "pan-y" }}>
        {error ? (
          <p data-details-error="" className="rounded-2xl bg-white/[0.06] px-4 py-5 text-center text-sm text-muted">
            {t("cinema.details.unavailable")}
          </p>
        ) : !data ? (
          <DetailsSkeleton label={t("common.loading")} />
        ) : (
          <DetailsBlocks data={data} locale={locale} t={t} />
        )}
      </div>
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
 * dans ma liste) ; la piste par défaut d'un fichier ne l'est pas. Elle se détache en blanc (`strong`).
 */
function Tag({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "strong" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight ${
        tone === "strong" ? "bg-white/20 text-white" : "bg-white/10 text-muted"
      }`}
    >
      {children}
    </span>
  );
}

function DetailsBlocks({ data, locale, t }: { data: FileStreamsResponse; locale: string; t: Translate }) {
  return (
    <>
      <PictureBlock data={data} locale={locale} t={t} />
      <SoundBlock data={data} locale={locale} t={t} />
      <SubtitlesBlock data={data} locale={locale} t={t} />
    </>
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

function SoundBlock({ data, locale, t }: { data: FileStreamsResponse; locale: string; t: Translate }) {
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
                {(a.isDefault || described) && (
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {a.isDefault && <Tag tone="strong">{t("cinema.details.default")}</Tag>}
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
 * « Forcés », « Malentendants », par la décision des menus (`subtitleKind`). Une piste posée à côté du
 * film le dit, une piste que Laterna a fait générer aussi. Deux pistes de même étiquette se comptent
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
    const origin = s.generated ? t("cinema.details.subGenerated") : s.external ? t("cinema.details.subExternal") : null;
    const text = origin ? `${kindText} · ${origin}` : kindText;
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
    <div data-round-toggle="" className="flex w-14 flex-col items-center gap-1">
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
      <span aria-hidden="true" data-round-caption="" className="text-center text-[11px] leading-tight text-muted">
        {t("cinema.details.caption")}
      </span>
    </div>
  );
}
