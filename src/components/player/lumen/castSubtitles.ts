// Le sous-titre porté au téléviseur par AirPlay sur Lumen serveur (DECISIONS.md §191) : les décisions pures de l'hôte.
//
// Le téléviseur ne lit que l'adresse de la liste maître que l'élément lui tend. Pour qu'il dessine le sous-titre
// choisi sur le téléphone, cette adresse porte `?st=<index Jellyfin>` : la liste maître gagne un seul rendu de
// sous-titres, DEFAULT=YES (`src/lib/lumenServer/subtitles.ts`). **Seulement pendant une diffusion** : dans la page,
// les sous-titres restent dessinés par notre calque (§190), et la liste maître reste celle d'avant à l'octet près — un
// rendu de sous-titres sous l'adresse de la page risquerait d'être dessiné par Safari sous le calque, ou de faire
// refuser l'élément comme les `<track>` posés avec l'adresse (code 4). Le banc `/lumen-test` éprouve cette forme dans
// la page (levier « sous-titres dans la liste ») avant qu'on en dise plus.
import type { ExternalSubtitleTrack } from "@/components/player/server/serverTracks";

/** Le paramètre de la liste maître qui demande le rendu de sous-titres. */
export const CAST_SUBTITLE_PARAM = "st";

/**
 * Le sous-titre que le téléviseur doit dessiner, en index Jellyfin, ou null (aucun). Seulement une piste de texte de
 * la liste (`/api/lumen/{id}/pistes`) : une piste en images (PGS, VobSub) n'a pas de WebVTT, une génération en cours
 * ou une piste générée relue sous un index négatif (§187) non plus.
 */
export function castSubtitleWanted(id: number | null, tracks: readonly Pick<ExternalSubtitleTrack, "index" | "isText">[]): number | null {
  if (id === null || id < 0) return null;
  const track = tracks.find((t) => t.index === id);
  return track && track.isText !== false ? id : null;
}

/**
 * « Diffuser » peut-il rester sur ce chemin ? Oui sans sous-titre, ou avec un sous-titre que la liste sait porter. Une
 * piste en images ou une génération en cours : le lecteur serveur, qui incruste (`castSubtitle.ts`), comme avant.
 */
export function castStaysOnLumen(id: number | null, tracks: readonly Pick<ExternalSubtitleTrack, "index" | "isText">[]): boolean {
  return id === null || castSubtitleWanted(id, tracks) !== null;
}

/** Le sous-titre que porte une adresse de liste maître (`?st=`), ou null. */
export function castSubtitleCarried(master: string | null): number | null {
  if (!master) return null;
  const query = master.split("#")[0].split("?")[1];
  if (!query) return null;
  const raw = new URLSearchParams(query).get(CAST_SUBTITLE_PARAM);
  return raw !== null && /^(0|[1-9]\d{0,3})$/.test(raw) ? Number(raw) : null;
}

/**
 * La même adresse avec ce sous-titre (ou sans) : chemin et autres paramètres intacts — le laissez-passer `tv.{jeton}`
 * reste dans le chemin, `audio` reste la piste son. Le fragment `#t=` n'est jamais gardé (l'appelant repose le sien).
 */
export function withCastSubtitle(master: string, st: number | null): string {
  const [path, query = ""] = master.split("#")[0].split("?");
  const params = new URLSearchParams(query);
  if (st === null) params.delete(CAST_SUBTITLE_PARAM);
  else params.set(CAST_SUBTITLE_PARAM, String(st));
  const search = params.toString();
  return `${path}${search ? `?${search}` : ""}`;
}

/**
 * Une piste de texte du navigateur qui vient du flux (un rendu de la liste maître) et non d'un `<track>` de la page.
 * WebKit les range après celles des `<track>` (HTML : éléments, puis `addTextTrack`, puis le flux), mais on ne compte
 * pas sur l'ordre : est « du flux » ce qu'aucun `<track>` de l'élément ne porte.
 */
export function inbandTextTracks(video: HTMLVideoElement): TextTrack[] {
  const list = video.textTracks;
  if (!list) return [];
  const elements = Array.from(video.querySelectorAll("track"));
  const owned = new Set<TextTrack>();
  for (const element of elements) {
    if (element.track) owned.add(element.track);
  }
  // Un environnement qui ne relie pas `<track>` à sa piste (`HTMLTrackElement.track` absent) : l'ordre de HTML.
  const byOrder = owned.size < elements.length;
  const out: TextTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const track = list[i];
    if (byOrder ? i >= elements.length : !owned.has(track)) out.push(track);
  }
  return out;
}

/** Les genres de pistes qu'un rendu `TYPE=SUBTITLES` devient dans WebKit (« forced » : un rendu FORCED=YES). */
const LEGIBLE_KINDS = new Set(["subtitles", "captions", "forced"]);

/**
 * Les modes des pistes du flux : `showing` pour le rendu de sous-titres pendant une diffusion qui le porte — c'est la
 * sélection du lecteur de WebKit, qu'AirPlay transmet au téléviseur avec l'adresse —, `disabled` partout ailleurs :
 * dans la page, Safari ne dessine rien sous notre calque (§190). Rend le nombre de pistes changées.
 */
export function applyInbandModes(video: HTMLVideoElement, show: boolean): number {
  let changed = 0;
  for (const track of inbandTextTracks(video)) {
    const wanted: TextTrackMode = show && LEGIBLE_KINDS.has(track.kind) ? "showing" : "disabled";
    if (track.mode !== wanted) {
      track.mode = wanted;
      changed += 1;
    }
  }
  return changed;
}
