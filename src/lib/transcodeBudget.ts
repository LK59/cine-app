/**
 * Les transcodages qu'un compte peut tenir ouverts en même temps chez Jellyfin, par le relais.
 *
 * Revue de sécurité du 20/10/2026 : le relais de flux (`/api/jellyfin/stream/…`) signe chaque
 * requête de la clé d'administration, et une adresse `master.m3u8?…&PlaySessionId=<nouveau>` y lance
 * un ffmpeg de plus — un par identifiant inventé, sans aucune borne, et hors de la politique de
 * transcodage que Jellyfin applique au compte (puisqu'il ne voit que l'administrateur). Un compte du
 * foyer pouvait ainsi occuper tout le processeur du serveur.
 *
 * Un transcodage, ici, c'est un `PlaySessionId` distinct sur une requête HLS (maître, variante,
 * segment) ou sur un flux progressif qui n'est pas `static=true` — voir `isTranscodeRequest`. Il
 * reste actif tant que ses segments sont demandés (`ACTIVE_MS`) ; une lecture qui s'arrête par la
 * route d'arrêt l'oublie tout de suite (`forgetTranscode`). Cinq par compte, administrateurs
 * compris : c'est large — une lecture, un changement de piste qui rouvre une séance, un téléviseur,
 * un second appareil — et ce n'est pas une politique d'usage, seulement un plafond contre l'abus
 * (décision du propriétaire, « très large genre 5 par compte simultané »).
 *
 * Tout l'état vit sur `globalThis` : la route et `instrumentation.ts` sont empaquetées séparément et
 * ce module peut exister en plusieurs copies (CLAUDE.md, `server-cache.ts`) — deux copies auraient
 * chacune leurs cinq places.
 */

export const TRANSCODE_LIMIT_PER_ACCOUNT = 5;
/** Une séance dont aucune requête n'est passée depuis trois minutes ne compte plus. */
export const ACTIVE_MS = 3 * 60_000;
/** Au plus tant de comptes suivis ; au-delà, les moins récemment vus partent d'abord. */
export const MAX_ACCOUNTS = 2_000;
/** Un refus journalisé au plus une fois par compte et par minute — un client qui réessaie en boucle ne remplit pas `server.log`. */
const REFUSAL_LOG_EVERY_MS = 60_000;
/** Un identifiant démesuré ne sert de clé qu'en partie : la mémoire reste bornée quoi qu'on envoie. */
const MAX_ID_LENGTH = 128;

interface State {
  /** compte → (séance → dernière requête, ms). L'ordre d'insertion du `Map` extérieur sert de LRU. */
  accounts: Map<string, Map<string, number>>;
  /** compte → dernier refus journalisé. */
  refusalLogged: Map<string, number>;
}

const STATE_KEY = Symbol.for("cine-app.transcodeBudget");

function state(): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>;
  return (holder[STATE_KEY] ??= { accounts: new Map(), refusalLogged: new Map() });
}

function prune(sessions: Map<string, number>, now: number): void {
  for (const [id, seen] of sessions) if (now - seen >= ACTIVE_MS) sessions.delete(id);
}

/**
 * Cette requête de transcodage peut-elle passer ? Oui pour une séance déjà active (sa date est
 * rafraîchie : ses segments la gardent en vie) ou pour une nouvelle tant que le compte en a moins de
 * cinq ; non sinon, et rien n'est noté.
 */
export function admitTranscode(account: string, playSessionId: string, now = Date.now()): boolean {
  const { accounts } = state();
  const id = playSessionId.slice(0, MAX_ID_LENGTH);
  const sessions = accounts.get(account) ?? new Map<string, number>();
  prune(sessions, now);
  if (!sessions.has(id) && sessions.size >= TRANSCODE_LIMIT_PER_ACCOUNT) return false;
  sessions.set(id, now);
  // Remis en queue : le compte devient le plus récent, et le plafond retire les plus anciens.
  accounts.delete(account);
  accounts.set(account, sessions);
  while (accounts.size > MAX_ACCOUNTS) {
    const oldest = accounts.keys().next().value;
    if (oldest === undefined) break;
    accounts.delete(oldest);
  }
  return true;
}

/** La lecture est arrêtée (`/api/jellyfin/playback/stop`) : sa place se libère tout de suite. */
export function forgetTranscode(account: string | null | undefined, playSessionId: unknown): void {
  if (!account || typeof playSessionId !== "string" || !playSessionId) return;
  const { accounts } = state();
  const sessions = accounts.get(account);
  if (!sessions) return;
  sessions.delete(playSessionId.slice(0, MAX_ID_LENGTH));
  if (sessions.size === 0) accounts.delete(account);
}

/** Faut-il journaliser ce refus ? Une fois par compte et par minute. */
export function shouldLogRefusal(account: string, now = Date.now()): boolean {
  const { refusalLogged } = state();
  const last = refusalLogged.get(account);
  if (last !== undefined && now - last < REFUSAL_LOG_EVERY_MS) return false;
  refusalLogged.delete(account);
  refusalLogged.set(account, now);
  while (refusalLogged.size > MAX_ACCOUNTS) {
    const oldest = refusalLogged.keys().next().value;
    if (oldest === undefined) break;
    refusalLogged.delete(oldest);
  }
  return true;
}

/** Les séances actives d'un compte — pour les tests et le diagnostic. */
export function activeTranscodes(account: string, now = Date.now()): number {
  const sessions = state().accounts.get(account);
  if (!sessions) return 0;
  prune(sessions, now);
  return sessions.size;
}

/** Pour les tests. */
export function resetTranscodeBudget(): void {
  const s = state();
  s.accounts.clear();
  s.refusalLogged.clear();
}
