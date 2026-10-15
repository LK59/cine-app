"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { detectCodecSupport } from "@/lib/codecSupport";
import { useSWRConfig } from "swr";
import { isAwaitingFresh } from "@/lib/persistentCache";
import { setWatchingFullScreen } from "@/lib/playbackBusy";
import { flushOrphanStops } from "@/lib/unsentStop";
import { flushUnsentLines } from "@/lib/unsentLines";
import { flushUnsentPositions, unsentPositionsPending } from "@/lib/unsentPosition";
import { carriedLighter } from "@/lib/playbackQuality";
import { parseReloadIntent, reloadedLighter, type ReloadCarry } from "@/lib/serverReload";
import { sleepTimerStore } from "@/lib/sleepTimer";
import { playBlockedByOutage } from "@/lib/catalogueOutage";
import { playBlockedByRetired } from "@/lib/retiredTitle";
import { introAllowedFor, introKey, preloadIntroArt, resolveIntroArt, startIntroClock, type IntroCacheReader, type PlaybackIntroArt } from "@/lib/playbackIntro";
import { holdPlayerEntry, installPlayerHistory, releasePlayerEntry } from "@/lib/playerHistory";

export interface PlaybackSession {
  itemId: string;
  title: string;
  /**
   * Le numéro de cette ouverture, posé par `play()`.
   *
   * Il fait partie de la clé des lecteurs : relancer le film déjà ouvert — « Recommencer » sur la
   * fiche d'un film réduit en mini-lecteur — réutilisait le lecteur en place, qui gardait sa
   * position et ignorait le « depuis le début » demandé ; le lecteur serveur ne faisait rien du
   * tout (relevé le 23/09/2026). Chaque appui sur Lire est une lecture neuve.
   */
  openId?: number;
  /** Resume position in seconds, if reopening a partially-watched item. */
  /**
   * Où ouvrir le film, en secondes.
   *
   * `0` veut dire « depuis le début », et il faut l'écrire. `undefined` veut dire « je n'ai pas
   * d'avis, prends ce dont le serveur se souvient » — ce qui n'est pas du tout la même chose.
   *
   * La confusion a coûté deux bugs à la fois. Le lecteur stable ne bougeait la tête que si la
   * valeur était vraie (`if (resumeAt)`), si bien qu'omettre le champ *et* passer zéro
   * revenaient au même : plusieurs appelants ont donc pris l'habitude de l'omettre pour
   * recommencer. Le lecteur natif, écrit après, lit `session.resumeAt ?? playbackState?.resumeSeconds` —
   * et pour lui un champ omis désigne précisément la position que l'on voulait écarter.
   * « Recommencer » reprenait donc au même endroit, et « Reprendre » repartait au début quand la
   * position mémorisée par le serveur, elle, était encore à zéro.
   */
  resumeAt?: number;
  /**
   * S'ouvrir en pause, à `resumeAt` : le retour sur le téléphone d'une diffusion qui s'est arrêtée
   * d'elle-même — voir `returnsPaused`. Posé par l'aiguillage des lecteurs, jamais par un appelant.
   */
  startPaused?: boolean;
  /** Only honored for the very first startPlayback call after opening — an initial audio track
   *  other than the default, used to resume into the right track after a WebKit reload-based
   *  track switch (see PLAYER_RELOAD_INTENT_KEY below). */
  initialAudioStreamIndex?: number;
  /** True when this session resumes a reload-based track switch. PlayerHost then delays the
   *  first load by a grace period: iOS's media daemon releases the previous page's HLS session
   *  asynchronously and roughly proportionally to how much it had buffered — verified live with
   *  byte-identical server responses producing success after a ~3s-old session but failure
   *  after an 8-minute one. Loading immediately on the fresh page races that release and gets
   *  refused (SRC_NOT_SUPPORTED); a short deliberate wait lets it finish first. */
  fromReload?: boolean;
  /** How many reload attempts this switch has already consumed — see PLAYER_RELOAD_ATTEMPTS_KEY. */
  reloadAttempt?: number;
  /**
   * L'élément que le lecteur **serveur** a rechargé la page pour rouvrir — posé seulement par la
   * relecture d'une intention marquée `server: true`, jamais par un appelant.
   *
   * Le rechargement efface `handedOver` et `takeover` : sans ce champ, l'aiguillage de PlayerHost
   * rouvrait le lecteur natif, qui ignore `initialAudioStreamIndex` — la piste choisie était perdue,
   * et après l'escalade de l'échelle audio le natif reprenait le fichier qu'il venait d'abandonner.
   * Un identifiant et non un booléen : il ne vaut que pour cet élément-là, comme `handedOver`.
   * L'épisode suivant, ou toute nouvelle séance, repart par l'aiguillage ordinaire.
   */
  reloadedOnServer?: string;
  /**
   * Ce que l'intention de rechargement emporte au-delà de la position et de la piste (`serverReload.ts`,
   * DECISIONS.md §78) : le palier allégé de la séance, le rechargement direct d'une bascule natif →
   * serveur, le sous-titre du relais, la séance du journal poursuivie. Posé seulement par la relecture
   * d'une intention écrite par le code du 12/10/2026 ; effacé par `advance` (il ne vaut que pour ce titre).
   */
  reloadCarry?: ReloadCarry;
  /**
   * Le palier de version allégée hérité d'une séance allégée qui s'est arrêtée il y a moins de deux
   * minutes (DECISIONS.md §78, `carriedLighter`) — posé à l'ouverture et à l'épisode suivant, jamais
   * ailleurs. Présent, la lecture part directement au lecteur serveur à ce débit.
   */
  lighter?: { targetBps: number; tier: number };
  /** Resolves the episode after `currentItemId`, if any — recomputed on every advance so the
   *  "next up" prompt keeps working after auto-advancing more than once in a row. Lost across a
   *  reload-based track switch (the page context it closed over doesn't survive) — an accepted,
   *  minor tradeoff: the "next episode" prompt just won't reappear for that session until the
   *  user navigates away and back, no crash either way. */
  getNextEpisode?: (currentItemId: string) => { itemId: string; title: string } | null;
  /**
   * L'identifiant d'une série du banc d'essai, quand c'est lui qui a ouvert le film.
   *
   * Trois effets, et seulement ceux-là : le lecteur expose son pont (`playerBench/bridge.ts`), ses
   * lignes au journal portent `bench`, et rien n'est rapporté à Jellyfin — un banc saute à la fin
   * des films, et chacun d'eux aurait été marqué vu, avec une reprise au milieu de nulle part.
   */
  bench?: string;
  /**
   * Une scène ouverte depuis une réplique (recherche de répliques, lecture à début − 5 s) : rien
   * n'est rapporté à Jellyfin ni gardé pour une reprise — ni battement, ni arrêt, ni « vu », ni
   * position gardée sur l'appareil —, et pas d'épisode suivant, tant que dix minutes n'ont pas été
   * jouées ; ensuite, c'est une lecture ordinaire (`sceneMode.ts`, DECISIONS.md §91). Posé par
   * l'appelant qui lance la scène, et par la relecture d'une intention de rechargement.
   */
  scene?: boolean;
  /** Le temps déjà joué de la scène, emporté par un rechargement de page — jamais par un appelant. */
  sceneWatchedMs?: number;
  /**
   * Le visuel, le logo et la place dans la série de ce qu'on lance — pour l'ouverture de la lecture
   * (DECISIONS.md §60). Posé par `play()` et `advance()` à partir de ce que l'appareil a déjà reçu,
   * jamais par un appelant : les endroits qui lancent un film n'ont pas à savoir qu'elle existe.
   * `null` : rien de trouvé, l'ouverture écrit le titre.
   */
  introArt?: PlaybackIntroArt | null;
}

// WebKit-only workaround (see the long comment in PlayerHost's changeAudio) for a reproducible
// "can't load a second HLS session in the same page" limitation: switching audio track there
// does a full page reload instead of switching in place, stashing just enough here to resume
// into the right track/position once the fresh page comes back up.
export const PLAYER_RELOAD_INTENT_KEY = "cine:player-reload-intent";

export type PlaybackMode = "closed" | "full" | "mini";

interface PlaybackContextValue {
  session: PlaybackSession | null;
  mode: PlaybackMode;
  play: (session: PlaybackSession) => void;
  /**
   * Fermer le lecteur. Avec un numéro d'ouverture, seulement si c'est encore cette lecture-là :
   * les deux lecteurs ferment au bout de leur fondu, et un film lancé pendant ces 200 ms était
   * refermé à sa place (relevé le 23/09/2026).
   */
  close: (openId?: number) => void;
  minimize: () => void;
  expand: () => void;
  advance: (next: { itemId: string; title: string }) => void;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error("usePlayback must be used within a PlaybackProvider");
  return ctx;
}

/**
 * Le seul mode du lecteur, « fermé » hors du fournisseur — pour un écran qui doit seulement savoir
 * s'il est recouvert (`playerHoldsKeyboard`) et qui se rend aussi hors du cinéma, où `usePlayback`
 * lèverait (les panneaux du cinéma, montés seuls dans leurs tests et dans le labo).
 */
export function usePlaybackMode(): PlaybackMode {
  return useContext(PlaybackContext)?.mode ?? "closed";
}

// Owns the single, app-wide "what's currently playing" state — deliberately separate from the
// component that actually renders the <video> (PlayerHost, mounted once in the dashboard
// layout) so play() can be called from anywhere (movie sheets, episode rows, dashboard cards)
// without each caller owning its own player instance. That's what lets playback survive
// navigating to a different page while minimized.
/** Voir `PlaybackSession.openId`. */
let openCounter = 0;
/** La seconde passe des lignes en attente après `online` — voir l'effet des envois en retard. */
const ONLINE_SECOND_FLUSH_MS = 5000;

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [mode, setMode] = useState<PlaybackMode>("closed");
  const { mutate, cache } = useSWRConfig();

  // Les bilans de séance restés sur l'appareil — une page tuée par iOS en arrière-plan n'a pas
  // pu envoyer le sien (voir unsentStop.ts). Au lancement, puis chaque minute : une application
  // relancée dans les deux minutes rouvre souvent le même film, et le bilan n'est déclaré perdu
  // qu'après ce délai. Avec elles, les lignes du journal qui n'ont pas pu partir — un redémarrage du
  // serveur, une coupure du réseau (voir unsentLines.ts, 01/10/2026).
  useEffect(() => {
    const flush = (launch: boolean) => {
      void flushOrphanStops();
      void flushUnsentLines();
      // Les positions qu'une coupure a gardées sur l'appareil (§78) : relues au lancement, puis
      // seulement si cette page en a gardé — sans quoi chaque minute parcourait tout `localStorage`.
      if (launch || unsentPositionsPending()) void flushUnsentPositions();
    };
    flush(true);
    const timer = setInterval(() => flush(false), 60_000);
    /**
     * Et au retour du réseau, tout de suite (15/10/2026, LECTEUR-4) : une coupure en plein film est
     * précisément ce qui remplit la file, et ses lignes attendaient jusqu'à une minute — souvent
     * au-delà de la fermeture de la page. Une seconde passe un peu après : `online` dit l'interface
     * revenue, pas encore le serveur joignable, et une passe s'arrête au premier échec.
     */
    let later: ReturnType<typeof setTimeout> | null = null;
    const onOnline = () => {
      void flushUnsentLines();
      if (later !== null) clearTimeout(later);
      later = setTimeout(() => {
        later = null;
        void flushUnsentLines();
      }, ONLINE_SECOND_FLUSH_MS);
    };
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", onOnline);
      if (later !== null) clearTimeout(later);
    };
  }, []);

  // Told to the rest of the app, which stops polling while the film has the whole screen.
  useEffect(() => {
    setWatchingFullScreen(mode === "full");
    return () => setWatchingFullScreen(false);
  }, [mode]);

  // « Reprendre » et « À suivre » sont relus à la fermeture par `refreshAfterPlayback`, appelé par
  // les deux lecteurs une fois le bilan de séance envoyé. Ils l'étaient aussi ici, dès la fin de la
  // séance : avant que Jellyfin ait noté l'arrêt — une seconde requête qui relisait l'ancienne
  // position (50 paires mesurées au journal du proxy, 08/10/2026).

  /**
   * Redemander ce que la pause a avalé.
   *
   * SWR ne rejoue pas une requête qu'il a sautée : `isPaused` la fait renoncer sans erreur, et
   * quand la pause se lève, cette clé reste sans réponse jusqu'à un remontage. Le commentaire de
   * SWRProvider promet que « tout se rattrape à la fermeture du lecteur » — c'était vrai des
   * écrans qu'on rouvre, faux de ceux restés montés derrière le film.
   *
   * Ce que ça coûtait, observé : après le rechargement que WebKit impose pour changer de piste, la
   * séance rouvre dès le montage, et la fiche derrière se monte donc pendant la pause. Sa requête
   * de configuration était perdue, `playerEnabled` retombait sur son défaut « non », et le bouton
   * Lire ne revenait plus — sur une page par ailleurs vivante. La recherche, elle, marchait très
   * bien : elle se monte à la demande, une fois la pause levée.
   *
   * On ne relance que les clés qui n'ont jamais rien reçu — ni donnée, ni erreur —, et celles dont
   * la seule donnée vient du cache gardé sur l'appareil. Une donnée
   * périmée se revalidera d'elle-même, une erreur a déjà sa propre logique de reprise, et
   * revalider tout le catalogue à chaque fermeture de film n'aurait servi personne.
   *
   * Placé après l'effet du dessus, dont il dépend : la pause doit être retombée pour que ces
   * revalidations partent au lieu d'être avalées à leur tour.
   */
  //
  // Seulement au moment où le film *libère* l'écran (08/10/2026). L'effet tournait aussi au
  // montage : SWR a déjà inscrit dans le cache, sans donnée ni erreur, chaque clé dont la requête
  // est en vol, et `mutate` la redemandait — sans déduplication. Chaque clé du premier rendu partait
  // deux fois à chaque lancement (`/api/maintenance`, `/api/reports/unread`, les préférences…).
  // Une clé déjà en cours de validation n'est pas avalée : elle n'est pas redemandée non plus.
  const prevMode = useRef(mode);
  useEffect(() => {
    const leftFullScreen = prevMode.current === "full" && mode !== "full";
    prevMode.current = mode;
    if (!leftFullScreen) return;
    for (const key of cache.keys()) {
      const entry = cache.get(key) as { data?: unknown; error?: unknown; isValidating?: boolean } | undefined;
      if (entry?.isValidating) continue;
      if (entry && entry.data === undefined && entry.error === undefined) void mutate(key);
      // Montrée depuis le cache de l'appareil et pas encore rafraîchie : sa requête a pu être
      // sautée de la même façon, et une clé pourvue n'aurait plus jamais été redemandée
      // (`persistentCache.ts`).
      else if (typeof key === "string" && isAwaitingFresh(key)) void mutate(key);
    }
  }, [mode, cache, mutate]);

  /**
   * The manifest asks for portrait, and it is right to: everything except a film is a list to
   * scroll. A film is the exception, and on Android that lock applies to it as well — the page
   * would simply refuse to turn. iOS ignores the manifest's orientation entirely, which is why
   * this only ever mattered on the platform nobody here can test on.
   *
   * So the lock is lifted for as long as a film has the whole screen, and asked for again after.
   * Every call is guarded: Safari implements none of this, and a refusal is not a reason for a
   * film to stop.
   */
  useEffect(() => {
    // Typed by hand: the orientation lock is not in the DOM library this project builds against,
    // being a proposal Safari has never implemented — which is exactly the platform where every
    // call below has to be allowed to be missing.
    const orientation = (typeof screen === "undefined" ? undefined : screen.orientation) as
      | (ScreenOrientation & { lock?: (to: string) => Promise<void>; unlock?: () => void })
      | undefined;
    if (!orientation) return;
    const ask = (what: "free" | "portrait") => {
      try {
        if (what === "free") orientation.unlock?.();
        else void orientation.lock?.("portrait-primary")?.catch(() => {});
      } catch {
        // Unsupported, or refused outside fullscreen. Nothing here is worth an interruption.
      }
    };
    ask(mode === "full" ? "free" : "portrait");
  }, [mode]);

  // Speculative, fire-and-forget: detectCodecSupport() already caches its result in
  // localStorage per browser/device (not per session, not per film) — this just moves that
  // one-time cost (a few hundred ms, the very first time ever on a given device) off the
  // critical path of actually pressing play, since it's mounted once for the whole app anyway.
  // A no-op on every later visit once the cache is warm.
  useEffect(() => {
    detectCodecSupport().catch(() => {});
  }, []);

  /**
   * L'ouverture de cette lecture commence à l'appui, pas au montage du lecteur : son horloge est
   * posée ici, son visuel cherché dans le cache de SWR et demandé tout de suite (DECISIONS.md §60).
   */
  const prepareIntro = useCallback(
    (s: PlaybackSession, openId: number | undefined): PlaybackIntroArt | null => {
      if (!introAllowedFor(s)) return null;
      startIntroClock(introKey(openId, s.itemId));
      let art: PlaybackIntroArt | null = null;
      try {
        art = resolveIntroArt(s.itemId, cache as unknown as IntroCacheReader);
      } catch {
        // Un ornement : une forme de cache inattendue ne doit jamais empêcher un film de partir.
      }
      preloadIntroArt(art);
      return art;
    },
    [cache]
  );

  const play = useCallback((s: PlaybackSession) => {
    // Jellyfin en panne (§92) : le lecteur ne s'ouvre pas — l'accueil le dit. L'ouvrir menait à un
    // écran noir, puis à un échec que le lecteur serveur aurait répété (il a besoin du même Jellyfin).
    if (playBlockedByOutage()) return;
    // Une fiche restée ouverte sur un titre que le catalogue vient de retirer (§96) : le dire.
    if (playBlockedByRetired()) return;
    // La minuterie de veille appartient à la séance (`sleepTimer.ts`) : une nouvelle ouverture
    // repart sans elle. L'épisode suivant, lui, passe par `advance`, qui la garde — c'est pour lui
    // qu'elle existe.
    sleepTimerStore.clear();
    openCounter += 1;
    const introArt = prepareIntro(s, openCounter);
    // Absent plutôt que nul quand rien n'est trouvé : la séance garde la forme que ses lecteurs connaissent.
    // La règle des deux minutes (§78) : décidée ici, une fois, pour toute la séance — en « Automatique »
    // seulement (`carriedLighter` ne rend rien en « Originale »).
    // Une page rechargée par le lecteur serveur dit elle-même son palier (`reloadCarry`) : la mémoire
    // des deux minutes n'a pas à le deviner — elle pouvait avoir expiré pendant une séance allégée.
    const lighter = s.reloadCarry ? reloadedLighter(s.reloadCarry) : carriedLighter();
    // Retour ferme le lecteur (`playerHistory.ts`) : son entrée d'historique, empilée ici, dans le
    // geste qui lance le film. Une page rechargée pour le rouvrir reprend celle qu'elle a gardée.
    holdPlayerEntry(openCounter, { adopt: s.fromReload === true });
    setSession({ ...s, openId: openCounter, ...(introArt ? { introArt } : {}), ...(lighter ? { lighter } : {}) });
    setMode("full");
  }, [prepareIntro]);

  const currentOpenId = useRef<number | undefined>(undefined);
  const currentSessionRef = useRef<PlaybackSession | null>(null);
  useEffect(() => {
    currentOpenId.current = session?.openId;
    currentSessionRef.current = session;
  }, [session]);
  const close = useCallback((openId?: number) => {
    if (openId !== undefined && currentOpenId.current !== openId) return;
    sleepTimerStore.clear();
    // La croix (ou la fin) rend l'entrée du lecteur : le Retour suivant ferme la fiche, pas l'application.
    releasePlayerEntry();
    setMode("closed");
    setSession(null);
  }, []);

  // Réduire quitte d'abord le plein écran : l'élément y restait, dans la couche du dessus, et les
  // règles `:fullscreen` du navigateur l'emportaient sur la position du mini-lecteur — une vidéo
  // plein écran habillée en mini-lecteur, qu'on ne pouvait ni déplacer ni quitter autrement
  // qu'avec Échap (relevé le 23/09/2026).
  // Le mini-lecteur n'a pas d'entrée d'historique : il vit sous la navigation, et Retour y referme
  // les fiches comme avant. Agrandi, il reprend la sienne.
  const minimize = useCallback(() => {
    if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    releasePlayerEntry();
    setMode("mini");
  }, []);
  const expand = useCallback(() => {
    holdPlayerEntry(currentOpenId.current);
    setMode("full");
  }, []);

  /**
   * Retour ferme le lecteur plein écran (`playerHistory.ts`). Le lecteur monté s'en charge lui-même,
   * par sa croix (`usePlayerBackClose`) ; s'il n'y en a pas encore (la séance attend ses réglages),
   * la séance se ferme ici. Branché avant la relecture d'une intention de rechargement, qui reprend
   * l'entrée gardée : sans intention, une entrée de lecteur restée dans une page rechargée n'a plus
   * de lecteur, et son jeton est effacé.
   */
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    let reloading = false;
    try {
      reloading = sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY) !== null;
    } catch {
      reloading = false;
    }
    return installPlayerHistory(() => closeRef.current(), reloading);
  }, []);

  // Resets resumeAt — an advance always starts the new episode from 0, matching the previous
  // per-invocation player's behavior.
  const advance = useCallback((next: { itemId: string; title: string }) => {
    // Zéro, et non « pas d'avis » : c'est bien depuis le début que l'épisode suivant commence.
    // L'ouverture est préparée hors de la fonction de mise à jour, qui doit rester pure : la séance
    // en cours est lue par la référence que l'effet plus haut tient à jour.
    const current = currentSessionRef.current;
    const introArt = current ? prepareIntro({ ...current, itemId: next.itemId, resumeAt: 0 }, current.openId) : null;
    // L'épisode suivant d'une séance allégée en hérite par la même règle (§78) : l'arrêt de l'épisode
    // vient d'être rapporté, et il a retenu son palier.
    const lighter = carriedLighter() ?? undefined;
    // `scene` ne passe pas à l'épisode suivant : il n'y en a pas pendant une scène, et après elle la
    // lecture est devenue ordinaire (`sceneMode.ts`).
    setSession((prev) => (prev ? { ...prev, itemId: next.itemId, title: next.title, resumeAt: 0, introArt, lighter, reloadCarry: undefined, scene: undefined, sceneWatchedMs: undefined } : prev));
  }, [prepareIntro]);

  // Resumes into a WebKit reload-based track switch — see PLAYER_RELOAD_INTENT_KEY. Runs once on
  // mount, before anything has had a chance to open a *different* player session, so there's no
  // risk of clobbering unrelated playback that might otherwise start first.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY);
      if (raw) sessionStorage.removeItem(PLAYER_RELOAD_INTENT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    // `server` : écrit par le lecteur serveur depuis le 29/09/2026. Une intention sans ce champ
    // (une page d'avant, rechargée sur ce code) garde l'aiguillage ordinaire. `carry` : depuis le
    // 12/10/2026 (`serverReload.ts`).
    const intent = parseReloadIntent(raw);
    if (!intent) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    play({
      itemId: intent.itemId,
      title: intent.title,
      resumeAt: intent.resumeAt,
      initialAudioStreamIndex: intent.audioStreamIndex,
      fromReload: true,
      reloadAttempt: intent.attempt ?? 0,
      ...(intent.server === true ? { reloadedOnServer: intent.itemId } : {}),
      ...(intent.carry ? { reloadCarry: intent.carry } : {}),
      // Une scène rechargée (WebKit) reste une scène, avec le temps qu'elle a déjà joué.
      ...(intent.carry?.scene ? { scene: true, sceneWatchedMs: intent.carry.scene.watchedMs } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PlaybackContext.Provider value={{ session, mode, play, close, minimize, expand, advance }}>
      {children}
    </PlaybackContext.Provider>
  );
}
