"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { Check } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";
import { toJellyfinLanguage } from "@/lib/trackPreferences";
import { useLocale, useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { PushToggle } from "@/components/PushToggle";
import { LanguageSelect, SubtitleModeSelect, NotificationChoices } from "./accountControls";
import type { PlayerPreferences } from "@/app/api/player/account/preferences/route";
import { OPEN_ONBOARDING_EVENT } from "./onboardingEvents";
import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/swr";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { prefetchImages, warmUpUrls } from "@/lib/cinemaWarmup";
import { scheduleDecoderWarmup } from "@/lib/webcodecs/decoderWarmup";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload } from "@/app/api/cinema/series/route";

/**
 * L'écran d'accueil — trois réglages, puis le cinéma (21/09/2026).
 *
 * Pourquoi : sur 21 comptes, 13 n'avaient ni langue audio ni langue de sous-titres, et un seul
 * avait choisi la langue de l'application. Tout le choix de piste (langue, puis la plus riche,
 * puis les forcés) ne sert à rien tant qu'un compte n'a rien demandé.
 *
 * Les règles de Louis, qui sont le contrat de cet écran :
 *  - il se propose tant que le marqueur du compte est allumé (voir `onboardingDb`) ;
 *  - « Passer » le cache jusqu'au prochain lancement seulement — `sessionStorage`, que ferme la
 *    fermeture de l'application, et au plus `SKIP_HOLD_MS` (voir là) ; une déconnexion en cours
 *    de route ne change rien ;
 *  - seul le bouton de fin éteint le marqueur ;
 *  - les réglages déjà faits chez Jellyfin sont préremplis ; le français seulement là où il n'y a
 *    rien, pour ne jamais écraser un choix fait exprès ;
 *  - tout se change ensuite dans Compte, et l'accueil s'y rouvre.
 *
 * Les contrôles sont ceux du panneau Compte (`accountControls`) : deux écrans qui recopieraient
 * leurs listes finiraient par proposer des choix différents pour la même chose.
 */

const SKIPPED_KEY = "cine:onboarding-skipped";
/**
 * Combien de temps « Passer » tient, au plus (24/09/2026).
 *
 * Le « prochain lancement » de `sessionStorage` n'arrive jamais sur un ordinateur : Safari garde
 * la session d'un onglet à travers les rechargements, et la rend à la réouverture des fenêtres.
 * Un compte sur Mac, passé une fois le 21/09, recevait encore « à faire » du serveur trois jours
 * plus tard sans que l'accueil s'affiche. On y range donc l'heure du « Passer » : il vaut pour la
 * soirée, pas pour la vie de l'onglet. L'ancienne valeur « 1 » se lit comme expirée.
 */
const SKIP_HOLD_MS = 6 * 3600_000;
/** L'étape où reprendre après le rechargement qu'impose un changement de langue. */
const RESUME_KEY = "cine:onboarding-resume";

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Navigation privée : l'accueil se reproposera, c'est tout.
  }
}

/**
 * Décide s'il faut montrer l'accueil — monté par la coquille du cinéma, sur toutes ses pages.
 */
export function PlayerOnboardingGate() {
  const { data } = useSWR<{ pending: boolean }>("/api/onboarding", fetcher, { revalidateOnFocus: false });
  // Lus une fois, au montage : ce sont des faits de ce lancement-ci.
  const [skipped] = useState(() => {
    const at = typeof window !== "undefined" ? Number(readSession(SKIPPED_KEY)) : NaN;
    return Number.isFinite(at) && Date.now() - at < SKIP_HOLD_MS;
  });
  const [resumeAt] = useState(() => {
    const raw = typeof window !== "undefined" ? readSession(RESUME_KEY) : null;
    return raw === null ? null : Number(raw) || 0;
  });
  const [manual, setManual] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const open = () => {
      setClosed(false);
      setManual(true);
    };
    window.addEventListener(OPEN_ONBOARDING_EVENT, open);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, open);
  }, []);

  const show = !closed && (manual || resumeAt !== null || (data?.pending === true && !skipped));
  if (!show) return null;
  return (
    <PlayerOnboarding
      startAt={resumeAt ?? 0}
      onSkip={() => {
        writeSession(SKIPPED_KEY, String(Date.now()));
        setClosed(true);
        setManual(false);
      }}
      onDone={() => {
        setClosed(true);
        setManual(false);
      }}
    />
  );
}

type Step = "welcome" | "playback" | "notifications" | "done";

export function PlayerOnboarding({
  startAt = 0,
  onSkip,
  onDone,
}: {
  startAt?: number;
  onSkip: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { locale, setLocale } = useLocale();
  const { data: me } = useSWR<{ username: string; jfUser: string | null }>("/api/auth/me", fetcher);
  const hasJellyfin = me ? me.jfUser != null : true;
  // Sans compte Jellyfin (le compte local), il n'y a pas de préférences de lecture à régler.
  const steps = useMemo<Step[]>(
    () => (hasJellyfin ? ["welcome", "playback", "notifications", "done"] : ["welcome", "notifications", "done"]),
    [hasJellyfin]
  );
  const [index, setIndex] = useState(() => Math.min(startAt, 3));
  const step = steps[Math.min(index, steps.length - 1)];
  const [busy, setBusy] = useState(false);

  // Après le rechargement d'une langue, on est revenu où il fallait : la reprise est consommée.
  useEffect(() => {
    writeSession(RESUME_KEY, null);
  }, []);

  /**
   * Pendant qu'on règle, l'application se prépare (21/09/2026).
   *
   * Au premier lancement de l'application installée, le stockage part de zéro — sur iPhone, il
   * est séparé de celui de Safari. L'accueil laisse une demi-minute où l'on ne regarde rien : on
   * s'en sert pour les images du premier écran (bannières, logos, têtes de rangées) et pour les
   * décodeurs du lecteur. Après un temps, pour ne rien disputer à l'affichage de l'accueil
   * lui-même, et quelques requêtes à la fois.
   */
  const swrOptions = { revalidateOnMount: false, revalidateOnFocus: false, revalidateIfStale: false };
  const { data: moviesCatalogue } = useSWR<CinemaMoviesPayload>(MOVIES_CATALOGUE_KEY, cinemaFetcher, swrOptions);
  const { data: seriesCatalogue } = useSWR<CinemaSeriesPayload>(SERIES_CATALOGUE_KEY, cinemaFetcher, swrOptions);
  useEffect(() => {
    /**
     * Le budget d'un téléphone, pas celui du bureau : les bannières de la une (dix titres), puis
     * les affiches des têtes de rangées — de l'ordre de 5 à 10 Mo. Les grandes images de toute la
     * bibliothèque, ou ses 720 affiches, seraient trop sur des données mobiles, et Safari ne dit
     * pas si l'on est en Wi-Fi.
     */
    const urls = [
      ...(moviesCatalogue
        ? [
            ...warmUpUrls(moviesCatalogue.spotlight, {}, (m) => m.radarrId, (m) => [m.backdropUrl, m.logoUrl], 10),
            ...warmUpUrls([], moviesCatalogue.rows, (m) => m.radarrId, (m) => [m.posterUrl], 60),
          ]
        : []),
      ...(seriesCatalogue
        ? [
            ...warmUpUrls(seriesCatalogue.spotlight, {}, (s) => s.sonarrId, (s) => [s.backdropUrl, s.logoUrl], 5),
            ...warmUpUrls([], seriesCatalogue.rows, (s) => s.sonarrId, (s) => [s.posterUrl], 40),
          ]
        : []),
    ];
    return prefetchImages(urls);
  }, [moviesCatalogue, seriesCatalogue]);
  useEffect(() => scheduleDecoderWarmup(2500), []);

  const [lang, setLang] = useState<Locale>(locale);

  const { data: prefs } = useSWR<PlayerPreferences>(hasJellyfin ? "/api/player/account/preferences" : null, fetcher, {
    revalidateOnFocus: false,
  });
  /**
   * Le préremplissage : ce qui existe chez Jellyfin, et le français seulement là où il n'y a rien.
   * « Quand l'audio n'est pas dans ma langue » seulement pour un compte qui n'avait rien réglé du
   * tout — « Selon le fichier » est aussi la valeur par défaut, on ne peut pas savoir s'il l'a
   * choisi, donc on ne la change que chez ceux qui n'ont visiblement rien touché.
   */
  const initial = useMemo(() => {
    if (!prefs) return null;
    const untouched = !prefs.audioLanguage && !prefs.subtitleLanguage;
    return {
      audioLanguage: toJellyfinLanguage(prefs.audioLanguage) ?? "fra",
      subtitleLanguage: toJellyfinLanguage(prefs.subtitleLanguage) ?? "fra",
      subtitleMode: untouched ? "Smart" : prefs.subtitleMode ?? "Default",
    };
  }, [prefs]);
  const [edits, setEdits] = useState<Partial<PlayerPreferences>>({});
  const playback = initial ? { ...initial, ...edits } : null;

  const pushSupported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

  async function next() {
    if (busy) return;
    if (step === "welcome" && lang !== locale) {
      // Le dictionnaire vient du serveur : seul un rechargement le remplace. On reprend ensuite
      // à l'étape suivante, dans la nouvelle langue.
      setBusy(true);
      writeSession(RESUME_KEY, String(index + 1));
      await setLocale(lang);
      setTimeout(() => window.location.reload(), 80);
      return;
    }
    if (step === "playback" && playback && prefs) {
      const changed =
        playback.audioLanguage !== toJellyfinLanguage(prefs.audioLanguage) ||
        playback.subtitleLanguage !== toJellyfinLanguage(prefs.subtitleLanguage) ||
        playback.subtitleMode !== (prefs.subtitleMode ?? "Default");
      if (changed) {
        setBusy(true);
        try {
          await apiAction("/api/player/account/preferences", { method: "POST", body: JSON.stringify(playback) });
        } catch (error) {
          toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
          setBusy(false);
          return;
        }
        setBusy(false);
      }
    }
    if (step === "done") {
      setBusy(true);
      try {
        await apiAction("/api/onboarding", { method: "POST" });
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
        setBusy(false);
        return;
      }
      onDone();
      return;
    }
    setIndex((i) => Math.min(i + 1, steps.length - 1));
  }

  if (typeof document === "undefined") return null;

  // La majuscule, pour l'affichage seulement : les noms de compte sont souvent tout en minuscules
  // (« louis »), et « Bienvenue, louis » a l'air d'une erreur. Le nom lui-même ne change pas.
  const rawName = me?.jfUser || me?.username || "";
  const name = rawName ? rawName.charAt(0).toLocaleUpperCase(locale) + rawName.slice(1) : "";
  const position = Math.min(index, steps.length - 1);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      // Échap vaut « Passer », et Tab reste dans l'accueil : c'est une fenêtre par-dessus tout,
      // et le panneau qui l'avait ouverte ne répond plus à ces touches tant qu'elle est là.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onSkip();
          return;
        }
        if (e.key !== "Tab") return;
        const focusable = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, a[href], [tabindex]:not([tabindex="-1"])')
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      aria-label={t("player.account.welcome")}
      className="fixed inset-0 flex animate-fade-in items-stretch justify-center overflow-y-auto bg-ink sm:items-center"
      style={{ zIndex: 70 }}
    >
      {/* Une lueur de la couleur d'accent, derrière tout : c'est la seule décoration de l'écran. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(60% 45% at 50% 0%, color-mix(in srgb, var(--color-accent-500) 22%, transparent), transparent 70%)",
        }}
      />

      <div
        className="relative flex w-full max-w-md flex-col px-6 sm:my-10 sm:rounded-2xl sm:border sm:border-white/10 sm:bg-white/[0.03] sm:px-8 sm:py-8 sm:shadow-2xl"
        style={{
          // Un vrai écart sous la zone sûre, et non la zone sûre seule : dans l'application installée,
          // iOS voile et floute le haut de l'écran sous la barre d'état, et la progression comme
          // « Passer » s'y lisaient à moitié (vu le 21/09/2026). Même remède que la barre du cinéma.
          paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.75rem)",
          paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
        }}
      >
        {/* La progression et « Passer », toujours au même endroit. */}
        <div className="flex items-center gap-4">
          <div className="flex flex-1 gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={position + 1} aria-label={t("player.onboarding.progress", { n: position + 1, total: steps.length })}>
            {steps.map((s, i) => (
              <span
                key={s}
                className={`h-1 flex-1 rounded-full transition-colors duration-300 ${i <= position ? "bg-white" : "bg-white/15"}`}
              />
            ))}
          </div>
          {step !== "done" && (
            <button type="button" onClick={onSkip} className="text-sm font-medium text-subtle transition-colors hover:text-white">
              {t("player.onboarding.skip")}
            </button>
          )}
        </div>

        {/* Le contenu de l'étape, remonté à chaque changement pour rejouer son entrée. */}
        <div key={step} className="flex flex-1 animate-fade-in-up flex-col justify-center py-10 sm:min-h-[26rem] sm:flex-none">
          {step === "welcome" && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon-192.png" alt="" className="mb-6 h-16 w-16 rounded-2xl shadow-lg shadow-black/40" />
              <h1 className="font-display text-3xl font-semibold leading-tight text-white">
                {t("player.onboarding.welcomeTitle", { name })}
              </h1>
              <p className="mt-3 text-base leading-relaxed text-muted">{t("player.onboarding.welcomeText")}</p>
              <p className="mb-2.5 mt-8 text-xs font-medium uppercase tracking-wider text-subtle">
                {t("player.onboarding.languageLabel")}
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                {LOCALES.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    aria-pressed={lang === l}
                    className={`chip justify-center py-2.5 ${lang === l ? "chip-on" : ""}`}
                  >
                    {LOCALE_LABELS[l]}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === "playback" && (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight text-white">{t("player.onboarding.playbackTitle")}</h1>
              <p className="mt-3 text-base leading-relaxed text-muted">{t("player.onboarding.playbackText")}</p>
              <div className="mt-8 flex flex-col gap-4">
                <LanguageSelect
                  label={t("player.account.audioLanguage")}
                  value={playback?.audioLanguage ?? null}
                  disabled={!playback || busy}
                  onChange={(code) => setEdits((e) => ({ ...e, audioLanguage: code }))}
                />
                <LanguageSelect
                  label={t("player.account.subtitleLanguage")}
                  value={playback?.subtitleLanguage ?? null}
                  disabled={!playback || busy}
                  onChange={(code) => setEdits((e) => ({ ...e, subtitleLanguage: code }))}
                />
                <SubtitleModeSelect
                  value={playback?.subtitleMode ?? null}
                  disabled={!playback || busy}
                  onChange={(mode) => setEdits((e) => ({ ...e, subtitleMode: mode }))}
                />
              </div>
              <p className="mt-4 text-xs leading-relaxed text-subtle">{t("player.onboarding.playbackNote")}</p>
            </>
          )}

          {step === "notifications" && (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight text-white">{t("player.onboarding.notifTitle")}</h1>
              <p className="mt-3 text-base leading-relaxed text-muted">{t("player.onboarding.notifText")}</p>
              <div className="mt-8">
                {pushSupported ? (
                  <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3.5">
                    <PushToggle />
                  </div>
                ) : (
                  // Sur iPhone, une page ouverte dans Safari ne peut pas s'abonner : il faut
                  // l'application installée. On le dit, et on laisse passer.
                  <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-3.5 text-sm leading-relaxed text-muted">
                    {t("player.onboarding.notifInstall")}
                  </p>
                )}
                <NotificationChoices />
              </div>
            </>
          )}

          {step === "done" && (
            <div className="flex flex-col items-center text-center">
              <span className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-accent-500/20 text-accent-400 ring-1 ring-accent-400/40">
                <Check size={30} />
              </span>
              <h1 className="font-display text-3xl font-semibold leading-tight text-white">{t("player.onboarding.doneTitle")}</h1>
              <p className="mt-3 max-w-xs text-base leading-relaxed text-muted">{t("player.onboarding.doneText")}</p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void next()}
            disabled={busy || (step === "playback" && !playback)}
            className="flex w-full items-center justify-center rounded-lg bg-white px-4 py-3.5 text-base font-semibold text-ink transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            {step === "done" ? t("player.onboarding.finish") : t("player.onboarding.next")}
          </button>
          {position > 0 && step !== "done" && (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              className="py-2 text-sm font-medium text-subtle transition-colors hover:text-white"
            >
              {t("player.onboarding.back")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
