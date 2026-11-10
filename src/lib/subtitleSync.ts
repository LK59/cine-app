/**
 * « Synchro des sous-titres » (DECISIONS.md §141) : ce que les lecteurs font d'une correction mesurée par
 * `laterna-xray` et appliquée par un administrateur — la règle, écrite une fois, pour le lecteur natif (à
 * chaque recherche de ligne), le lecteur serveur et les téléchargements (le WebVTT réécrit par la route des
 * sous-titres).
 *
 * **Le modèle** : `t_parole = a + s · t_sous-titre` sur l'horloge du fichier — `a` le décalage (secondes), `s`
 * l'échelle (une dérive : un sous-titre fait pour une copie à 25 i/s posé sur un fichier à 23,976). Afficher la
 * ligne juste à l'instant `p`, c'est chercher la réplique datée `(p − a) / s` dans le sous-titre. Aucun fichier
 * n'est jamais réécrit sur le disque : la correction vit dans `cine.db` et s'applique à l'affichage.
 *
 * Ce module ne lit rien du serveur : il est importé par le lecteur.
 */

export interface SubtitleSync {
  /** `a`, en secondes : le décalage qui pose le sous-titre sur la parole (le « décalage » du menu). */
  offset: number;
  /** `s` : 1 pour un simple décalage. */
  scale: number;
}

/**
 * L'instant à chercher dans une piste, pour une position du lecteur `playerSeconds`.
 *
 * - `fileDelay` : l'écart entre l'horloge du lecteur et celle du fichier (`presentationDelay`) ;
 * - `offset` : le décalage de la piste — celui que le spectateur règle, qui part de la correction ;
 * - `scale` : l'échelle de la correction (1 sans correction) ;
 * - `onFileClock` : une piste datée sur l'horloge du fichier (un fichier à côté du film, une génération) ;
 *   sinon une piste du conteneur, datée sur celle du lecteur.
 *
 * Fichier : `(p − fileDelay − offset) / scale`. Conteneur : `fileDelay + (p − fileDelay − offset) / scale`.
 *
 * **À l'échelle 1, exactement le calcul d'avant**, opération pour opération : `(p − offset) − fileDelay` pour
 * un fichier, `p − offset` pour le conteneur — un arrondi différent au dernier bit aurait suffi à faire changer
 * de ligne un instant pile sur une borne, et les empreintes du lecteur l'auraient vu.
 */
export function cueLookupTime(playerSeconds: number, fileDelay: number, offset: number, scale: number, onFileClock: boolean): number {
  const at = playerSeconds - offset;
  if (scale === 1 || !Number.isFinite(scale) || scale <= 0) return onFileClock ? at - fileDelay : at;
  const file = (at - fileDelay) / scale;
  return onFileClock ? file : fileDelay + file;
}

/** Une correction qui ne change rien (ou illisible) : traitée comme une absence. */
export function isNeutralSync(sync: SubtitleSync | null | undefined): boolean {
  return !sync || !Number.isFinite(sync.offset) || !Number.isFinite(sync.scale) || sync.scale <= 0 || (sync.offset === 0 && sync.scale === 1);
}

/** Le décalage de départ du menu « décalage » : au centième, pour un chiffre lisible (l'erreur de mesure est de dizaines de millisecondes). */
export function startingOffset(sync: SubtitleSync | null | undefined): number {
  return isNeutralSync(sync) ? 0 : Math.round(sync!.offset * 100) / 100;
}

const VTT_TIMING = /^(\s*)((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(\s+-->\s+)((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(.*)$/;

function parseStamp(stamp: string): number {
  const [hms, frac] = stamp.split(/[.,]/);
  const parts = hms.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2] + Number(frac) / 10 ** frac.length;
}

function formatStamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/**
 * Le WebVTT de Jellyfin, ses temps portés en `a + s·t` — pour le lecteur serveur (l'élément `<track>` du
 * navigateur, d'un téléviseur en diffusion) et les téléchargements, qui lisent le fichier tel quel. Le reste du
 * fichier (en-tête, réglages de position, texte) est rendu tel quel ; une réplique qui tomberait avant zéro y est
 * ramenée.
 */
export function rewriteVttTimes(vtt: string, sync: SubtitleSync): string {
  if (isNeutralSync(sync)) return vtt;
  const map = (t: number) => sync.offset + sync.scale * t;
  return vtt
    .split("\n")
    .map((line) => {
      const m = VTT_TIMING.exec(line);
      if (!m) return line;
      return `${m[1]}${formatStamp(map(parseStamp(m[2])))}${m[3]}${formatStamp(map(parseStamp(m[4])))}${m[5]}`;
    })
    .join("\n");
}

/** La clé d'une piste dans `subtitle_sync` : `emb:<index du flux>` pour le conteneur, `ext:<chemin>` pour un fichier à côté. */
export function subtitleTrackKey(stream: { Index: number; IsExternal?: boolean; Path?: string | null }): string | null {
  if (stream.IsExternal) return stream.Path ? `ext:${stream.Path}` : null;
  return `emb:${stream.Index}`;
}

/**
 * Pour la ligne `start` du journal du lecteur : les corrections appliquées à ce fichier, en une chaîne courte
 * (`« 3:+2.44s, 5:-1.2s×25→23.976 »`, par index Jellyfin). Absente sans correction — la ligne reste celle d'avant.
 */
export function subSyncLogField(byIndex: Record<string, SubtitleSync & { label?: string | null }> | null | undefined): { subSync: string } | Record<string, never> {
  if (!byIndex) return {};
  const parts = Object.entries(byIndex)
    .filter(([, s]) => !isNeutralSync(s))
    .map(([index, s]) => `${index}:${s.offset >= 0 ? "+" : ""}${Math.round(s.offset * 100) / 100}s${s.scale !== 1 ? `×${s.label ?? s.scale.toFixed(5)}` : ""}`);
  return parts.length ? { subSync: parts.join(", ") } : {};
}

/** La même chose pour le lecteur serveur, depuis les pistes que `playback/start` rend (`sync` sur une piste recalée). */
export function subSyncFromTracks(tracks: unknown): { subSync: string } | Record<string, never> {
  if (!Array.isArray(tracks)) return {};
  const byIndex: Record<string, SubtitleSync> = {};
  for (const t of tracks as { index?: unknown; sync?: SubtitleSync }[]) {
    if (typeof t?.index === "number" && t.sync) byIndex[String(t.index)] = t.sync;
  }
  return subSyncLogField(byIndex);
}
