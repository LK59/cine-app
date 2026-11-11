import { api } from "../lib/session";

/**
 * Les sous-titres d'un film, dessinés sur les télévisions.
 *
 * Le texte vient de l'application, déjà converti en WebVTT (`/api/jellyfin/stream/subtitle/…`, la route que
 * le lecteur serveur emploie). Il est lu ici, réplique par réplique, et la réplique du moment est dessinée
 * dans un petit canevas que les écrans posent en bas de l'image (`world/Screens.tsx`) : comme sur une vraie
 * télévision, on le lit d'où l'on est assis, sur chaque écran.
 *
 * Les sous-titres en images (PGS, VobSub) ne sont pas du texte : la route ne les rend pas en WebVTT, il n'y
 * a alors rien à dessiner — le choix retombe sur « aucun ».
 */
export interface Cue {
  from: number;
  to: number;
  text: string;
}

const clock = (stamp: string): number => {
  const parts = stamp.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};

/** Lit un WebVTT : ses répliques, dans l'ordre, sans leurs balises de mise en forme. */
export function parseVtt(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [from, rest] = lines[at].split("-->");
    const to = (rest ?? "").trim().split(/\s+/)[0];
    const text = lines
      .slice(at + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .trim();
    const start = clock(from);
    const end = clock(to);
    if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) cues.push({ from: start, to: end, text });
  }
  return cues.sort((a, b) => a.from - b.from);
}

/** Les répliques de la piste choisie ; vide : pas de sous-titres. */
let cues: Cue[] = [];
let cursor = 0;
let loading = 0;

/** Charge les répliques d'une piste. Rend faux si elle ne se lit pas (piste en images, panne). */
export async function loadSubtitles(url: string | null): Promise<boolean> {
  const mine = ++loading;
  cues = [];
  cursor = 0;
  if (!url) return true;
  try {
    const response = await api(url);
    if (!response.ok) return false;
    const parsed = parseVtt(await response.text());
    if (mine !== loading) return true;
    cues = parsed;
    return parsed.length > 0;
  } catch {
    return false;
  }
}

/** La réplique à afficher à cet instant du film, ou une chaîne vide. */
export function cueAt(time: number): string {
  if (!cues.length) return "";
  // Le film avance : la recherche repart d'où elle était ; après un saut en arrière, elle recommence.
  if (cursor >= cues.length || cues[cursor].from > time) cursor = 0;
  while (cursor < cues.length - 1 && cues[cursor].to < time) cursor++;
  const cue = cues[cursor];
  return time >= cue.from && time <= cue.to ? cue.text : "";
}

/** Le canevas où la réplique est dessinée : large comme l'image, haut d'un peu plus du quart. */
export const SUBTITLE_SIZE = { width: 1280, height: 200 } as const;

/** Dessine une réplique (deux lignes au plus tiennent ; au-delà, le corps rétrécit). */
export function drawCue(context: CanvasRenderingContext2D, text: string): void {
  const { width, height } = SUBTITLE_SIZE;
  context.clearRect(0, 0, width, height);
  if (!text) return;
  const lines = text.split("\n").slice(0, 3);
  let size = lines.length > 2 ? 44 : 54;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  const fit = () => {
    context.font = `600 ${size}px Inter, system-ui, sans-serif`;
    return Math.max(...lines.map((line) => context.measureText(line).width));
  };
  while (fit() > width - 60 && size > 26) size -= 2;
  const step = size * 1.22;
  const top = height - 18 - step * (lines.length - 0.5);
  lines.forEach((line, i) => {
    const y = top + i * step;
    context.strokeStyle = "rgba(0, 0, 0, 0.92)";
    context.lineWidth = size * 0.2;
    context.strokeText(line, width / 2, y);
    context.fillStyle = "#ffffff";
    context.fillText(line, width / 2, y);
  });
}
