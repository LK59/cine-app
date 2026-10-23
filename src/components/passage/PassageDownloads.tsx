"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Download, X } from "lucide-react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { usePlaybackMode } from "@/components/PlaybackProvider";
import { fetcher } from "@/lib/swr";
import { formatFileSize } from "@/lib/format";
import { ABOVE_BOTTOM_BAR, PROMPT_CLOSE_CLASS } from "@/lib/floatingPrompt";
import { PROMPT_RANK, useFloatingPromptTurn } from "@/lib/floatingPromptTurn";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { deviceStoreSupported } from "@/lib/offline/deviceStore";
import { useOfflineDownloadsEnabled } from "@/lib/offline/useOfflineEnabled";
import { useOldAddress } from "@/lib/passage/useOldAddress";
import { passageDownloadsBytes, type PassageDownload } from "@/lib/passage/downloads";
import {
  forgetPassageOffer,
  freeOldAddressDownloads,
  notePassageOfferPrompted,
  relaunchPassageDownloads,
  usePassageOffer,
} from "@/lib/passage/offer";

/**
 * Les téléchargements hors ligne et le passage d'adresse, à l'écran (DECISIONS.md §119) : l'invitation
 * à retélécharger sur la nouvelle adresse, son rappel dans la page des téléchargements, et le mot
 * « effacés de l'ancienne adresse » quand celle-ci a libéré sa place.
 */

/** Laissé au lancement le temps de s'installer, comme les autres invitations flottantes. */
const SHOW_DELAY_MS = 2500;
/** Le mot de l'ancienne adresse se retire seul. */
const FREED_SHOWN_MS = 10_000;

function useAccount(): string | null {
  const [account] = useState(() => (typeof window === "undefined" ? null : persistedCacheAccount()));
  return account;
}

/** « Retélécharger vos 2 téléchargements (1,2 Go) ? » */
function useOfferTitle(items: readonly PassageDownload[]): string {
  const t = useT();
  const { locale } = useLocale();
  const size = formatFileSize(passageDownloadsBytes(items), locale);
  return items.length === 1 ? t("passage.downloads.offerOne", { size }) : t("passage.downloads.offerMany", { n: items.length, size });
}

function useRelaunch(items: readonly PassageDownload[] | null) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    relaunch: async () => {
      if (!items || busy) return;
      setBusy(true);
      try {
        await relaunchPassageDownloads(items);
      } finally {
        setBusy(false);
      }
    },
  };
}

/**
 * L'invitation, une fois, au lancement du cinéma sur la nouvelle adresse (application installée
 * comprise) : jamais pendant un film, ni pendant l'écran d'accueil d'un premier lancement, ni par-dessus
 * l'aide d'installation, les Nouveautés ou l'invitation aux notifications (`floatingPromptTurn`).
 * Montrée, elle compte comme faite : « Plus tard » (ou la croix) la renvoie à la page des
 * téléchargements, où elle reste jusqu'à ce qu'on la ferme.
 */
export function PassageDownloadsPrompt() {
  const t = useT();
  const mode = usePlaybackMode();
  const account = useAccount();
  const offer = usePassageOffer(account);
  const enabled = useOfflineDownloadsEnabled();
  const { data: onboarding } = useSWR<{ pending?: boolean }>("/api/onboarding", fetcher, { revalidateOnFocus: false });
  const [ready, setReady] = useState(false);
  const [later, setLater] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const eligible = ready && !!offer && !offer.prompted && enabled && deviceStoreSupported() && mode === "closed" && onboarding?.pending === false;
  // Montrée, elle reste jusqu'à la réponse — `prompted` posé, elle ne serait plus « éligible » — et
  // garde sa place parmi les invitations (un film ouvert la retire, sans la rendre éligible de nouveau).
  const [shownOnce, setShownOnce] = useState(false);
  const wanted = !later && (shownOnce ? mode === "closed" : eligible);
  const turn = useFloatingPromptTurn("passage-downloads", PROMPT_RANK.passage, wanted);
  if (wanted && turn && !shownOnce) setShownOnce(true);
  useEffect(() => {
    if (shownOnce) notePassageOfferPrompted();
  }, [shownOnce]);
  const items = offer?.items ?? null;
  const title = useOfferTitle(items ?? []);
  const { busy, relaunch } = useRelaunch(items);
  if (!shownOnce || !wanted || !turn || !items) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-60 flex justify-center px-3 pb-3" style={{ paddingBottom: ABOVE_BOTTOM_BAR }}>
      <div role="dialog" aria-label={title} data-passage-downloads-prompt="" className="glass-panel pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl px-4 py-3 shadow-glow">
        <Download size={16} className="mt-0.5 shrink-0 text-accent-400" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">{t("passage.downloads.offerBody")}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                await relaunch();
                setLater(true);
              }}
              data-passage-downloads-relaunch=""
              className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-black hover:bg-white/90 disabled:opacity-60"
            >
              {t("passage.downloads.relaunch")}
            </button>
            <button type="button" onClick={() => setLater(true)} data-passage-downloads-later="" className="rounded-full px-3 py-1 text-[12px] text-white/80 hover:text-white">
              {t("passage.downloads.later")}
            </button>
          </div>
        </div>
        <button type="button" onClick={() => setLater(true)} aria-label={t("passage.downloads.later")} className={`${PROMPT_CLOSE_CLASS} text-subtle hover:text-white`}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * Le rappel dans la page des téléchargements, tant que l'invitation n'a été ni acceptée ni fermée.
 * Seulement avec du réseau et le hors ligne ouvert : la page sert aussi `/hors-ligne`.
 */
export function PassageDownloadsCard() {
  const t = useT();
  const account = useAccount();
  const offer = usePassageOffer(account);
  const enabled = useOfflineDownloadsEnabled();
  const items = offer?.items ?? null;
  const title = useOfferTitle(items ?? []);
  const { busy, relaunch } = useRelaunch(items);
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  if (!items || !enabled || !online) return null;
  return (
    <div data-passage-downloads-card="" className="flex items-start gap-3 rounded-2xl bg-white/4 px-4 py-4 ring-1 ring-inset ring-accent-400/30 sm:px-5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/8 text-white">
        <Download size={17} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="mt-0.5 text-xs text-subtle">{t("passage.downloads.offerBody")}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void relaunch()}
          data-passage-downloads-relaunch=""
          className="mt-3 rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-black hover:bg-white/90 disabled:opacity-60"
        >
          {t("passage.downloads.relaunch")}
        </button>
      </div>
      <button type="button" onClick={forgetPassageOffer} aria-label={t("passage.downloads.dismiss")} className={`${PROMPT_CLOSE_CLASS} text-subtle hover:text-white`}>
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Sur l'ancienne adresse, au lancement : ce que le serveur atteste récupéré sur la nouvelle s'efface
 * de l'appareil (`freeOldAddressDownloads`), jamais pendant une lecture — un film ouvert attend sa
 * fermeture —, puis un mot le dit : « 2 téléchargements effacés de l'ancienne adresse : ils sont dans
 * Laterna ». Une fois par chargement.
 */
export function PassageDownloadsCleanup() {
  const t = useT();
  const mode = usePlaybackMode();
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const { old } = useOldAddress();
  const enabled = useOfflineDownloadsEnabled();
  // Une fois par chargement. Une référence et non un état : posé en état, il relançait l'effet, dont
  // le nettoyage jetait la réponse — les fichiers partaient sans que le mot paraisse (essai de bout en
  // bout du 23/10/2026).
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [freed, setFreed] = useState(0);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (started.current || old !== true || !enabled || mode !== "closed" || !deviceStoreSupported()) return;
    const timer = setTimeout(() => {
      started.current = true;
      void freeOldAddressDownloads(() => modeRef.current !== "closed")
        .then((removed) => {
          if (mounted.current && removed.length) setFreed(removed.length);
        })
        .catch(() => undefined);
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [old, enabled, mode]);
  const wanted = freed > 0 && !closed && mode === "closed";
  const turn = useFloatingPromptTurn("passage-freed", PROMPT_RANK.passage, wanted);
  useEffect(() => {
    if (!wanted || !turn) return;
    const timer = setTimeout(() => setClosed(true), FREED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [wanted, turn]);
  if (!wanted || !turn) return null;
  const text = freed === 1 ? t("passage.downloads.freedOne") : t("passage.downloads.freedMany", { n: freed });
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-60 flex justify-center px-3 pb-3" style={{ paddingBottom: ABOVE_BOTTOM_BAR }}>
      <div role="status" data-passage-downloads-freed="" className="glass-panel pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl px-4 py-3 shadow-glow">
        <Download size={16} className="mt-0.5 shrink-0 text-accent-400" />
        <p className="min-w-0 text-xs text-white">{text}</p>
        <button type="button" onClick={() => setClosed(true)} aria-label={t("common.close")} className={`${PROMPT_CLOSE_CLASS} text-subtle hover:text-white`}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
