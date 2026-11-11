import type { ClientMessage, ServerMessage, Visibility } from "../../../salons/src/protocol";
import type { QuizView } from "../../../salons/src/quiz";
import { useStore } from "../state/store";
import { forgetPoses, poses, pushPose } from "./poses";
import { applyShared, installSharedSink, seedShared } from "./sync";
import { IDLE_NET, type NetState } from "./types";

export type { NetState, NetStatus, PublicRoom } from "./types";

/**
 * Les salons du chalet, côté navigateur (DECISIONS.md §146, `docs/MULTIJOUEUR.md`).
 *
 * Une seule WebSocket vers `/api/salons/ws` — la même adresse que la page, le même HTTPS : l'application la relaie
 * vers le service `laterna-salons`. Pour y entrer, un laissez-passer (`/api/salons/pass`, derrière la session),
 * redemandé à chaque connexion. Sans service, ou fonction coupée, la route dit `available: false` : le chalet reste
 * seul, et rien d'autre ne change.
 *
 * Ce module ne décide de rien pour le salon : il envoie des intentions et écrit dans l'état (`net`) ce que le
 * service a appliqué. Un objet partagé n'est jamais changé ici avant que le service l'ait renvoyé.
 *
 * Les coupures : une connexion perdue (application redéployée, réseau, service redémarré) est rouverte d'elle-même,
 * de plus en plus patiemment, avec le jeton de reprise — le service rend alors la même place et le même salon s'il
 * les a gardés (60 s). Le jeton et le code du salon sont aussi gardés pour l'onglet (`sessionStorage`) : un
 * rechargement de la page dans la minute retrouve son salon.
 */

/** Codes de fermeture du service (`salons/src/server.ts`). */
const CLOSE_PASS = 4401;
const CLOSE_RATE = 4429;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000];
const CLOCK_SAMPLES = 5;
const CLOCK_EVERY_MS = 60_000;
const SAVED = "immersion-salon";

let ws: WebSocket | null = null;
/** Le visiteur veut être en ligne : une coupure est réparée. Faux après « quitter » ou si le service n'est pas là. */
let wanted = false;
let attempt = 0;
let passRefusals = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let resume: string | null = null;
/** Les intentions demandées avant que la connexion soit ouverte (lister, créer, rejoindre), dans l'ordre. */
let pending: ClientMessage[] = [];
/** L'ouverture en cours : une seule à la fois (le menu demande la connexion et la liste au même instant). */
let opening: Promise<void> | null = null;
let bestRtt = Infinity;

const net = () => useStore.getState().net;
const setNet = (patch: Partial<NetState>) => useStore.getState().setNet(patch);

function save(): void {
  try {
    const room = net().room;
    if (resume) sessionStorage.setItem(SAVED, JSON.stringify({ resume, code: room?.code ?? null }));
  } catch {
    /* navigation privée : on se passe de la reprise après rechargement */
  }
}

function saved(): { resume: string | null; code: string | null } {
  try {
    const raw = sessionStorage.getItem(SAVED);
    return raw ? (JSON.parse(raw) as { resume: string | null; code: string | null }) : { resume: null, code: null };
  } catch {
    return { resume: null, code: null };
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(SAVED);
  } catch {
    /* rien */
  }
}

/** L'heure du service, maintenant (pour tout ce qui est daté par lui). */
export function serverNow(): number {
  return Date.now() + net().offset;
}

function send(message: ClientMessage): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

/** Demande au service une intention ; si la connexion n'est pas encore ouverte, elle part à l'ouverture. */
function request(message: ClientMessage): void {
  if (!send(message)) {
    pending.push(message);
    if (!ws) void connect();
  }
}

function syncClock(): void {
  bestRtt = Infinity;
  for (let i = 0; i < CLOCK_SAMPLES; i++) setTimeout(() => send({ t: "ping", c: performance.now() }), i * 150);
}

function onMessage(message: ServerMessage): void {
  const state = net();
  switch (message.t) {
    case "welcome": {
      resume = message.resume;
      if (message.room) enterRoom(message.room, false);
      attempt = 0;
      passRefusals = 0;
      setNet({ status: "online", you: message.you, room: message.room, error: null, offset: message.now - Date.now() });
      save();
      syncClock();
      if (clockTimer) clearInterval(clockTimer);
      clockTimer = setInterval(syncClock, CLOCK_EVERY_MS);
      // Revenu sans sa place (gardée trop longtemps, service redémarré) mais un salon était ouvert : on le rejoint.
      const remembered = saved().code;
      const queued = pending;
      pending = [];
      for (const m of queued) send(m);
      if (!queued.some((m) => m.t === "create" || m.t === "join") && !message.room && remembered) send({ t: "join", code: remembered });
      return;
    }
    case "pong": {
      const now = performance.now();
      const rtt = now - message.c;
      if (rtt >= 0 && rtt < bestRtt) {
        bestRtt = rtt;
        // `s` a été lu au milieu de l'aller-retour : l'heure du navigateur à cet instant est `now − rtt/2`.
        setNet({ offset: message.s - (Date.now() - rtt / 2), rtt: Math.round(rtt) });
      }
      return;
    }
    case "rooms":
      return setNet({ publicRooms: message.rooms });
    case "joined":
      setNet({ room: message.room, error: null, chat: state.room?.code === message.room.code ? state.chat : [] });
      enterRoom(message.room, true);
      save();
      return;
    case "left":
      setNet({ room: null, chat: [] });
      forgetPoses();
      for (const listener of gameListeners) listener(null, undefined);
      save();
      return;
    case "enter":
      if (state.room) setNet({ room: { ...state.room, members: [...state.room.members.filter((m) => m.id !== message.member.id), message.member] } });
      return;
    case "exit":
      poses.delete(message.id);
      if (state.room) setNet({ room: { ...state.room, members: state.room.members.filter((m) => m.id !== message.id) } });
      return;
    case "away":
      if (state.room) setNet({ room: { ...state.room, members: state.room.members.map((m) => (m.id === message.id ? { ...m, away: message.away } : m)) } });
      return;
    case "state": {
      const room = state.room;
      if (!room) return;
      // Un changement plus vieux que ce qu'on a (arrivé en retard) ne revient pas en arrière.
      if ((room.state[message.key]?.v ?? 0) >= message.v) return;
      const next = { ...room.state, [message.key]: { v: message.v, value: message.value } };
      setNet({ room: { ...room, state: next } });
      applyShared(next);
      return;
    }
    case "pos":
      pushPose(message.id, message.p);
      return;
    case "chat":
      setNet({ chat: [...state.chat, { id: message.id, name: message.name, text: message.text, at: Date.now() }].slice(-50) });
      return;
    case "roster": {
      const waiting = rosterWaiters;
      rosterWaiters = [];
      for (const resolve of waiting) resolve(message.token);
      return;
    }
    case "game":
      if (state.room) setNet({ room: { ...state.room, game: message.game } });
      for (const listener of gameListeners) listener(message.game, message.result);
      return;
    case "error":
      // Un salon disparu (fermé, service redémarré) n'est plus à rejoindre au prochain retour.
      if (message.code === "no-room") forget();
      setNet({ error: message.code });
      return;
  }
}

function scheduleRetry(): void {
  if (!wanted || retryTimer) return;
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  setNet({ status: "reconnecting" });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

/** Le laissez-passer : `null` si le jeu à plusieurs n'est pas pour cette session (ou si la route ne répond pas). */
async function fetchPass(): Promise<{ pass: string; socket: string } | null> {
  try {
    const res = await fetch("/api/salons/pass", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { available?: boolean; pass?: string; socket?: string };
    return body.available && body.pass && body.socket ? { pass: body.pass, socket: body.socket } : null;
  } catch {
    return null;
  }
}

/** Le jeu à plusieurs est-il ouvert à cette session ? Pose `unavailable` sinon. Ne se connecte pas. */
export async function probeSalons(): Promise<boolean> {
  if (net().status !== "off" && net().status !== "unavailable") return true;
  setNet({ status: "checking" });
  const pass = await fetchPass();
  setNet({ status: pass ? "off" : "unavailable" });
  return !!pass;
}

/** Ouvre la connexion (ou la rouvre). Une seule ouverture à la fois. */
export function connect(): Promise<void> {
  if (ws) return Promise.resolve();
  opening ??= open().finally(() => {
    opening = null;
  });
  return opening;
}

async function open(): Promise<void> {
  wanted = true;
  if (!resume) resume = saved().resume;
  setNet({ status: attempt === 0 ? "connecting" : "reconnecting" });
  const pass = await fetchPass();
  if (!wanted || ws) return;
  if (!pass) {
    // Plus disponible (coupé entre-temps, session finie) : le chalet redevient solitaire.
    wanted = false;
    setNet({ ...IDLE_NET, status: "unavailable" });
    return;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const query = `pass=${encodeURIComponent(pass.pass)}${resume ? `&resume=${encodeURIComponent(resume)}` : ""}`;
  const socket = new WebSocket(`${scheme}://${location.host}${pass.socket}?${query}`);
  ws = socket;
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      onMessage(JSON.parse(event.data) as ServerMessage);
    } catch {
      /* un message illisible du service ne casse pas la page */
    }
  };
  socket.onclose = (event) => {
    if (ws !== socket) return;
    ws = null;
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    if (!wanted) {
      forgetPoses();
      return setNet({ ...IDLE_NET, status: "off" });
    }
    // Laissez-passer refusé : un autre, une fois ; deux de suite, la clé ne correspond pas — on n'insiste pas.
    if (event.code === CLOSE_PASS && ++passRefusals >= 2) {
      wanted = false;
      return setNet({ ...IDLE_NET, status: "unavailable" });
    }
    if (event.code === CLOSE_RATE) setNet({ error: "rate" });
    scheduleRetry();
  };
}

/** Quitte le salon et coupe la connexion : le chalet redevient solitaire. */
export function disconnect(): void {
  wanted = false;
  pending = [];
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (net().room) send({ t: "leave" });
  forget();
  resume = null;
  const socket = ws;
  ws = null;
  socket?.close(1000);
  setNet({ ...IDLE_NET, status: "off" });
}

export function listRooms(): void {
  request({ t: "list" });
}

export function createRoom(visibility: Visibility, name = ""): void {
  setNet({ error: null });
  request({ t: "create", visibility, name });
}

export function joinRoom(code: string): void {
  setNet({ error: null });
  request({ t: "join", code: code.trim().toUpperCase() });
}

export function leaveRoom(): void {
  request({ t: "leave" });
}

/** Demande un changement d'objet partagé ; il ne s'applique qu'au retour du service. */
export function setShared(key: string, value: unknown): void {
  send({ t: "set", key, value });
}

/**
 * Arrivé dans un salon (ou revenu dans le sien) : son état appliqué au chalet, les positions connues des autres, la
 * partie en cours. Le premier arrivé d'un salon neuf y pose l'état de son chalet.
 */
function enterRoom(room: NonNullable<NetState["room"]>, fresh: boolean): void {
  applyShared(room.state);
  forgetPoses(new Set(room.members.map((m) => m.id)));
  for (const m of room.members) if (m.p && m.id !== net().you?.id) pushPose(m.id, m.p);
  if (fresh && room.members.length === 1) seedShared(room);
  for (const listener of gameListeners) listener(room.game, undefined);
}

/** Où l'on est, pour les autres (`[cm, cm, cm, mrad, mrad, bits]`). Rien hors d'un salon. */
export function sendPos(p: number[]): void {
  if (net().room) send({ t: "pos", p });
}

export function sendChat(text: string): void {
  const clean = text.trim().slice(0, 200);
  if (clean && net().room) send({ t: "chat", text: clean });
}

let rosterWaiters: ((token: string | null) => void)[] = [];

/** La liste des présents signée par le service, pour préparer une partie ; `null` sans réponse (5 s). */
export function requestRoster(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!send({ t: "roster" })) return resolve(null);
    const timer = setTimeout(() => {
      rosterWaiters = rosterWaiters.filter((w) => w !== done);
      resolve(null);
    }, 5000);
    const done = (token: string | null) => {
      clearTimeout(timer);
      resolve(token);
    };
    rosterWaiters.push(done);
  });
}

/** Les intentions de la partie (lancer, répondre, arrêter) : c'est le service qui les applique. */
export function sendGame(message: Extract<ClientMessage, { t: "game.start" | "game.answer" | "game.stop" }>): boolean {
  return send(message);
}

type GameListener = (game: QuizView | null, result: string | undefined) => void;
const gameListeners = new Set<GameListener>();

/** La partie du salon, à chaque changement (`game/quiz.ts`). Rend de quoi se désabonner. */
export function onGame(listener: GameListener): () => void {
  gameListeners.add(listener);
  return () => gameListeners.delete(listener);
}

installSharedSink((key, value) => send({ t: "set", key, value }), serverNow);

/** Pour les scénarios : coupe la connexion comme le ferait le réseau (la reprise doit suivre). */
export function dropForTest(): void {
  ws?.close(4000, "coupure de test");
}
