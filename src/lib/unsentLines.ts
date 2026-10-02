"use client";

import { persistedCacheAccount } from "@/lib/persistentCache";

/**
 * Les lignes du journal du lecteur qui n'ont pas pu partir, gardées sur l'appareil et renvoyées.
 *
 * Le 01/10/2026, le conteneur a redémarré à 19:47:06 pendant qu'un spectateur regardait : le point
 * de la réserve d'avance dû vers 19:46:53 manque à sa séance. Envoyé pendant que le serveur ne
 * répondait pas, il a échoué, et rien ne l'a jamais renvoyé. Seul le bilan (`stop`) survivait, par
 * son propre filet (`unsentStop.ts`) ; toute autre ligne envoyée pendant un déploiement, un
 * redémarrage ou une coupure du réseau du spectateur était perdue — des trous dans la trace au
 * moment exact où il se passe quelque chose.
 *
 * Le même filet que celui du bilan, pour le reste : une file bornée dans `localStorage`, renvoyée
 * après le prochain envoi réussi et au lancement suivant, chaque ligne gardée avec son compte.
 *
 * - **Seulement sur un échec sans réponse de l'application** : le réseau (`fetch` rejeté), ou un
 *   5xx — le 502/503 du relais pendant que le conteneur redémarre. Un 4xx est une réponse : la ligne
 *   a été refusée et le serait encore (400), ou le compte est hors de session (401/403), ou il envoie
 *   trop vite (429) — la renvoyer ne ferait que l'aggraver.
 * - **Jamais deux fois** : chaque ligne part avec un identifiant (`lineId`). Une réponse perdue
 *   après une écriture réussie — la page qui s'en va, le réseau qui tombe au retour — laisse une
 *   ligne écrite *et* en file ; la route se souvient des identifiants qu'elle a écrits et ne réécrit
 *   pas un renvoi déjà reçu (`playerLogIds.ts`).
 * - **Datée de son premier envoi** : le serveur date chaque ligne à son arrivée et ne laisse pas le
 *   navigateur le faire (journal falsifiable, 22/09/2026). Un renvoi porte `resent: true` et
 *   `lateByMs`, l'écart, mesuré sur l'appareil, entre le premier envoi et celui-ci — comme le bilan
 *   perdu. La lecture du journal le replace à l'instant qu'il décrit (`lineTime`).
 * - **Bornée** : `MAX_LINES` lignes, `MAX_BYTES` octets, les plus anciennes chassées d'abord, et
 *   rien de plus vieux que `KEEP_MS`. Une coupure d'une heure en plein film en écrit une centaine.
 *
 * Le bilan reste à part : il est réécrit au fil de la séance, et sa ligne n'existe pas tant que la
 * séance n'est pas finie. Une ligne `stop` envoyée qui échoue entre ici, comme les autres — son
 * double gardé par `unsentStop` est effacé au même instant (`reportStop`), elle ne part donc qu'une
 * fois. Une ligne confiée à `sendBeacon` n'y entre jamais : le navigateur ne dit pas ce qu'elle est
 * devenue.
 *
 * Le stockage peut manquer ou refuser (navigation privée, stockage plein) : tout est dans un `try`,
 * et la page se passe alors de filet.
 */

const KEY = "cine:unsent-lines";
export const MAX_LINES = 100;
/** Une ligne `stall` porte jusqu'à 4 000 caractères de trace : une soixantaine tient là-dedans. */
export const MAX_BYTES = 256 * 1024;
/** Le bilan perdu d'un autre compte attend une semaine ; une ligne ordinaire, pas davantage. */
export const KEEP_MS = 7 * 24 * 3600_000;
/** Par passe : bien en dessous des 120 lignes par minute que la route accepte d'un compte. */
const PER_FLUSH = 30;

export interface UnsentLine {
  id: string;
  kind: string;
  fields: Record<string, unknown>;
  /** L'instant du premier envoi, sur l'horloge de l'appareil. */
  at: number;
  account: string | null;
}

/** Un identifiant court pour chaque ligne envoyée — de quoi reconnaître un renvoi déjà reçu. */
export function newLineId(): string {
  let id = "";
  while (id.length < 16) id += Math.random().toString(36).slice(2);
  return id.slice(0, 16);
}

/** Une réponse qui ne vient pas de l'application : la ligne n'a pas été écrite. */
export function shouldKeep(status: number | null): boolean {
  return status === null || status >= 500;
}

function read(): UnsentLine[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is UnsentLine =>
        Boolean(l) && typeof l.id === "string" && typeof l.kind === "string" && typeof l.at === "number" && Boolean(l.fields) && typeof l.fields === "object"
    );
  } catch {
    return [];
  }
}

/** Écrit la file, en chassant les plus anciennes jusqu'à tenir dans les bornes. */
function write(lines: UnsentLine[], now: number): void {
  try {
    let kept = lines.filter((l) => now - l.at < KEEP_MS).slice(-MAX_LINES);
    let text = JSON.stringify(kept);
    while (kept.length && text.length > MAX_BYTES) {
      kept = kept.slice(1);
      text = JSON.stringify(kept);
    }
    if (kept.length) localStorage.setItem(KEY, text);
    else localStorage.removeItem(KEY);
  } catch {
    // Pas de stockage, ou plein : la ligne est perdue, comme avant.
  }
}

/** Garde une ligne qui n'a pas pu partir. `fields` porte déjà le build et la version d'origine. */
export function keepUnsentLine(id: string, kind: string, fields: Record<string, unknown>, now = Date.now()): void {
  const lines = read();
  // Déjà en file (un renvoi qui échoue encore) : elle y reste telle quelle, datée de son premier envoi.
  if (lines.some((l) => l.id === id)) return;
  write([...lines, { id, kind, fields, at: now, account: persistedCacheAccount() }], now);
}

/** Les lignes en file, telles qu'elles partiraient — pour les tests et la lecture. */
export function unsentLines(): UnsentLine[] {
  return read();
}

function drop(id: string, now: number): void {
  write(
    read().filter((l) => l.id !== id),
    now
  );
}

/**
 * Renvoie ce qui attend, du plus ancien au plus récent. Appelé après chaque envoi réussi, au
 * lancement, puis chaque minute avec les bilans perdus (`PlaybackProvider`).
 *
 * Par `fetch` et retiré seulement sur une réponse acceptée, comme le bilan perdu. La passe s'arrête
 * au premier échec : le serveur toujours absent, inutile d'essayer la suite une à une.
 */
let flushing = false;

export async function flushUnsentLines(now = Date.now()): Promise<void> {
  // Une passe lente ne doit pas croiser la suivante : la même ligne partirait deux fois.
  if (flushing) return;
  flushing = true;
  try {
    await sendQueued(now);
  } finally {
    flushing = false;
  }
}

async function sendQueued(now: number): Promise<void> {
  const account = persistedCacheAccount();
  // Personne de connu (l'écran de connexion) : la route refuserait, et la ligne n'est à personne.
  if (!account) return;
  // Celles d'un autre compte attendent son retour : sur un iPad partagé, la séance d'une personne
  // ne doit pas s'écrire au nom d'une autre (même règle que `unsentStop`).
  const mine = read()
    .filter((l) => !l.account || l.account === account)
    .slice(0, PER_FLUSH);
  for (const line of mine) {
    let status: number | null = null;
    try {
      const res = await fetch("/api/player/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: line.kind,
          fields: { ...line.fields, lineId: line.id, resent: true, lateByMs: Math.max(0, now - line.at) },
        }),
      });
      status = res.status;
      if (res.ok) {
        drop(line.id, now);
        continue;
      }
    } catch {
      // Toujours hors ligne.
    }
    // 400 : le serveur ne veut pas de cette ligne, et ne la voudra jamais.
    if (status === 400) {
      drop(line.id, now);
      continue;
    }
    return;
  }
}
