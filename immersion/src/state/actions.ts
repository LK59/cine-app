import { device, onIntent, view, type Intent } from "../input/intents";
import { disposeAudio, resumeAudio } from "../media/audio";
import { disposeMusic } from "../media/music";
import { episodesOf, forgetLibrary, library, type Title } from "../media/library";
import { dispatch } from "../media/commands";
import { acceptPrompt, dismissPrompt } from "../media/upNext";
import { answerQuiz } from "../game/quiz";
import { leaveToLaterna } from "../lib/session";
import { SCREENS, SOFA } from "../world/layout";
import { SEATS, THINGS } from "../world/interactions";
import { aimedScreen, placePanel } from "../world/panel";
import { rig } from "../world/rig";
import { EMPTY_PANEL, useStore } from "./store";
import { Vector3 } from "three";

/**
 * Les actions : tout ce que le visiteur peut faire, en un seul endroit, sans rien savoir de la façon
 * dont c'est demandé (une touche, un clic, demain une gâchette) ni de la façon dont c'est montré (du
 * HTML aujourd'hui, une interface en 3D demain). Les périphériques émettent des intentions
 * (`input/intents.ts`) ; l'interface appelle ces fonctions ; elles seules changent l'état.
 */
const state = () => useStore.getState();

/** Dans un script de test, le verrou du pointeur n'existe pas : ne pas retomber en pause faute de lui. */
export const debug = { skipCaptureCheck: false };

// ── Entrer, reprendre, quitter ───────────────────────────────────────────────────────────────────

/** Le geste d'entrée : il donne le regard au périphérique et réveille le son. */
export function enterWorld(): void {
  device.current.capture();
  resumeAudio();
}

/** Après le fondu de l'accueil : le monde. Sans regard capturé (refus rare), il s'ouvre sur le menu pause. */
export function worldEntered(): void {
  state().setMode(device.current.captured() || debug.skipCaptureCheck ? "walk" : "paused");
  state().setPhase("world");
}

/** Reprendre la visite depuis le menu pause. À appeler dans un geste. */
export function resumeVisit(): void {
  device.current.capture();
  if (debug.skipCaptureCheck) state().setMode("walk");
}

/** Le périphérique vient de prendre ou de rendre le regard. */
export function captureChanged(captured: boolean): void {
  const s = state();
  if (captured) s.setMode("walk");
  // Rendu sans qu'on l'ait demandé (Échap, changement de fenêtre) : c'est le menu.
  else if (s.phase === "world" && s.mode === "walk") s.setMode("paused");
}

/** Quitter : la lecture est arrêtée et annoncée, le son rendu, le monde démonté, puis la page part. */
export function quit(): void {
  device.current.release();
  dispatch({ type: "stop" });
  disposeMusic();
  disposeAudio();
  state().setPhase("leaving");
  setTimeout(leaveToLaterna, 60);
}

// ── Le panneau Laterna ───────────────────────────────────────────────────────────────────────────

function loadLibrary(): void {
  const s = state();
  if (s.panel.library) return;
  s.setPanel({ libraryFailed: false });
  library().then(
    (data) => state().setPanel({ library: data }),
    () => state().setPanel({ libraryFailed: true })
  );
}

/** Ouvre le panneau devant l'écran donné (ou celui que le visiteur peut ouvrir d'ici). */
export function openPanel(screenId?: string): void {
  const s = state();
  // Depuis la télécommande aussi : son bouton « Laterna » ouvre le panneau complet devant le même écran.
  if (s.phase !== "world" || (s.mode !== "walk" && s.mode !== "remote")) return;
  const screen = SCREENS.find((candidate) => candidate.id === (screenId ?? (s.mode === "remote" ? remoteScreen : null) ?? s.nearScreen));
  if (!screen) return;
  placePanel(screen);
  // Assis, l'image rapprochée (molette) ne laisse qu'une douzaine de degrés de champ : le panneau, réduit pour y tenir
  // (`panelScale`), deviendrait illisible. Il s'ouvre sur la vue normale.
  view.zoom = 0;
  loadLibrary();
  // Le mode d'abord : rendre le regard ensuite est voulu, et ne doit pas ouvrir le menu pause.
  s.setMode("panel");
  device.current.release();
}

/** Ferme le panneau et rend le regard au visiteur. À appeler dans un geste. */
export function closePanel(): void {
  const s = state();
  if (s.mode !== "panel") return;
  rig.aim = null;
  s.setPanel({ opened: null, episodes: null, episodesFailed: false, season: null });
  backToWalk();
}

/** Rend le regard au visiteur — après le panneau ou la télécommande. À appeler dans un geste. */
function backToWalk(): void {
  const s = state();
  s.setMode("walk");
  device.current.capture();
  if (debug.skipCaptureCheck) return;
  // Le navigateur peut refuser (juste après un Échap) : le menu pause propose alors de reprendre.
  setTimeout(() => {
    const now = state();
    if (now.phase === "world" && now.mode === "walk" && !device.current.captured()) now.setMode("paused");
  }, 350);
}

export function setPanelQuery(query: string): void {
  state().setPanel({ query, opened: null, episodes: null });
}

export function setPanelTab(tab: "movies" | "series"): void {
  state().setPanel({ tab });
}

export function setPanelSeason(season: number): void {
  state().setPanel({ season });
}

/** Ouvre la fiche d'un titre ; pour une série, ses épisodes sont demandés. */
export function openTitle(title: Title): void {
  state().setPanel({ opened: title, episodes: null, episodesFailed: false, season: null });
  if (title.kind !== "series") return;
  episodesOf(title.itemId).then(
    (data) => {
      if (state().panel.opened?.key !== title.key) return;
      const upcoming = data.episodes.find((e) => e.itemId === data.next);
      state().setPanel({ episodes: { list: data.episodes, next: data.next }, season: upcoming?.season ?? data.episodes[0]?.season ?? null });
    },
    () => state().panel.opened?.key === title.key && state().setPanel({ episodesFailed: true })
  );
}

/** Un cran en arrière : la fiche, puis la recherche, puis le panneau. */
export function panelBack(): void {
  const { panel } = state();
  if (panel.opened) state().setPanel({ opened: null, episodes: null, episodesFailed: false });
  else if (panel.query) state().setPanel({ query: "" });
  else closePanel();
}

/** Lance un titre sur les télévisions et referme le panneau. `from` : une position imposée, sinon la reprise du compte. */
export function launch(itemId: string, name: string, from: number | null): void {
  // « Reprendre » aura changé après cette lecture.
  forgetLibrary();
  state().setPanel({ ...EMPTY_PANEL, tab: state().panel.tab });
  dispatch({ type: "open", item: { id: itemId, title: name }, from });
  closePanel();
}

// ── La télécommande ──────────────────────────────────────────────────────────────────────────────

/** L'écran devant lequel la télécommande a été ouverte : c'est devant lui que « Laterna » ouvre le panneau. */
let remoteScreen: string | null = null;

/**
 * Pose la télécommande au bas de l'image (`ui/Remote.tsx`) : lecture, sauts, progression, sous-titres, sans
 * couvrir l'image comme le panneau. Le regard est rendu le temps de s'en servir — c'est ce qui permet de la
 * cliquer. Seulement pendant une lecture : sans film, toucher l'écran ouvre le panneau, comme avant.
 */
export function openRemote(screenId: string): void {
  const s = state();
  if (s.phase !== "world" || s.mode !== "walk") return;
  remoteScreen = screenId;
  s.setMode("remote");
  device.current.release();
}

/** Retire la télécommande et rend le regard. À appeler dans un geste (un clic hors d'elle, Échap). */
export function closeRemote(): void {
  if (state().mode !== "remote") return;
  backToWalk();
}

export function stopPlayback(): void {
  dispatch({ type: "stop" });
}

// ── S'asseoir ────────────────────────────────────────────────────────────────────────────────────

export function toggleSeat(): void {
  const s = state();
  if (s.seated) return s.setSeated(false);
  const spot = s.nearSeat;
  if (!spot) return;
  const seat = SEATS[spot];
  // Le corps va se poser à côté : c'est là qu'on se relève.
  rig.teleport = new Vector3(...seat.stand);
  if (seat.yaw !== undefined) rig.yaw = seat.yaw;
  if (seat.pitch !== undefined) rig.pitch = seat.pitch;
  s.setSeated(true, spot);
}

// ── Les intentions ───────────────────────────────────────────────────────────────────────────────

function handle(intent: Intent): void {
  const s = state();
  if (s.phase !== "world") return;
  if (s.mode === "panel") {
    if (intent === "back") panelBack();
    return;
  }
  if (s.mode === "remote") {
    if (intent === "back") closeRemote();
    return;
  }
  if (s.mode === "paused") {
    // Dans les réglages, « retour » revient au menu ; au menu, il reprend la visite.
    if (intent === "back") {
      if (s.pauseView !== "menu") s.setPauseView("menu");
      else resumeVisit();
    }
    return;
  }
  switch (intent) {
    case "interact": {
      // Une chose regardée de près passe avant l'écran : une lampe, le feu, la porte, le chat.
      const thing = s.nearThing ? THINGS.find((candidate) => candidate.id === s.nearThing) : null;
      if (thing) return thing.act(s);
      return openPanel();
    }
    case "select": {
      // Pendant une lecture, l'écran visé appelle la télécommande ; le panneau complet reste sous E (ou par elle).
      const screen = aimedScreen();
      const playing = s.playback.status === "playing" || s.playback.status === "paused";
      if (screen && playing) openRemote(screen.id);
      else if (screen) openPanel(screen.id);
      return;
    }
    case "accept":
      return acceptPrompt();
    case "dismiss":
      return dismissPrompt();
    case "chat":
      // Le chat n'existe que dans un salon.
      if (s.net.room) s.setChatOpen(true);
      return;
    case "choice1":
    case "choice2":
    case "choice3":
    case "choice4":
      return answerQuiz(Number(intent.slice(-1)) - 1);
    case "sit":
      return toggleSeat();
    case "menu":
      device.current.release();
      return s.setMode("paused");
    case "playPause":
      dispatch({ type: "toggle" });
      break;
    case "mute":
      dispatch({ type: "mute" });
      break;
    case "seekBack":
      dispatch({ type: "seekBy", delta: -10 });
      break;
    case "seekForward":
      dispatch({ type: "seekBy", delta: 10 });
      break;
    default:
      return;
  }
  // Un geste de lecture montre le HUD un instant.
  s.wakeHud();
}

/** Branche les actions sur les intentions. Rend la fonction qui les débranche. */
export function listenIntents(): () => void {
  return onIntent(handle);
}
