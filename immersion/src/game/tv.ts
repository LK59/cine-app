import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import type { QuizView } from "../../../salons/src/quiz";
import { translate, type Key, type Lang } from "../lib/i18n";

/**
 * « Devine le film » sur les télévisions du chalet : une image dessinée par la page (1280 × 720), que les écrans
 * montrent à la place du film pendant une partie (`world/Screens.tsx`) — la lumière des écrans suit, comme pour un
 * film.
 *
 * L'indice se précise avec le temps : l'affiche floue devient nette, l'image du film se dézoome, la distribution se
 * dévoile nom après nom. Le flou est fait par réduction puis agrandissement (une petite image étirée) : le filtre de
 * flou des canevas n'existe pas dans Safari sur iPhone.
 */
const W = 1280;
const H = 720;

const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
if (canvas) {
  canvas.width = W;
  canvas.height = H;
}
const small = typeof document !== "undefined" ? document.createElement("canvas") : null;

export const quizTv = {
  texture: canvas ? Object.assign(new CanvasTexture(canvas), { colorSpace: SRGBColorSpace, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false }) : null,
  /** Une partie est montrée : les écrans prennent cette image au lieu du film. */
  active: false,
  lastDraw: 0,
};

const images = new Map<string, HTMLImageElement>();
function image(url: string): HTMLImageElement | null {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.src = url;
    images.set(url, img);
    if (images.size > 40) images.delete(images.keys().next().value!);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Précharge les images d'une partie (toutes ses manches) : l'indice est prêt quand la manche commence. */
export function preloadQuiz(view: QuizView, rounds?: { image?: string }[]): void {
  for (const r of rounds ?? (view.clue ? [view.clue] : [])) if (r.image) image(r.image);
}

const BG = "#0b0a0c";
const INK = "#f4efe6";
const MUTED = "rgba(244,239,230,0.62)";
const BRAND = "#f5b83d";
const GOOD = "#4ade80";

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, line: number, maxLines: number): number {
  const words = text.split(/\s+/);
  let current = "";
  let lines = 0;
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (ctx.measureText(attempt).width > width && current) {
      ctx.fillText(current, x, y + lines * line);
      lines += 1;
      current = word;
      if (lines >= maxLines - 1) break;
    } else current = attempt;
  }
  if (current && lines < maxLines) ctx.fillText(current, x, y + lines * line);
  return lines + 1;
}

/** Une image dans un cadre, floue selon `sharp` (0 : illisible, 1 : nette) et agrandie selon `zoom` (≥ 1). */
function drawPicture(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, sharp: number, zoom: number): void {
  const ratio = img.naturalWidth / img.naturalHeight;
  let dw = w;
  let dh = w / ratio;
  if (dh > h) {
    dh = h;
    dw = h * ratio;
  }
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  const sw = img.naturalWidth / zoom;
  const sh = img.naturalHeight / zoom;
  const sx = (img.naturalWidth - sw) / 2;
  const sy = (img.naturalHeight - sh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(dx, dy, dw, dh, 14);
  ctx.clip();
  if (sharp >= 0.999 || !small) {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  } else {
    const scale = 0.015 + 0.985 * sharp * sharp;
    small.width = Math.max(3, Math.round(dw * scale));
    small.height = Math.max(3, Math.round(dh * scale));
    const sctx = small.getContext("2d")!;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(img, sx, sy, sw, sh, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, dx, dy, dw, dh);
  }
  ctx.restore();
}

/** Redessine l'image de la partie à l'instant `now` (heure de la vue : celle du service à plusieurs). */
export function drawQuiz(view: QuizView, you: string, choice: number | null, now: number, lang: Lang): void {
  const ctx = canvas?.getContext("2d");
  if (!ctx || !quizTv.texture) return;
  const t = (key: Key) => translate(lang, key);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.3, H * 0.4, 50, W * 0.3, H * 0.4, 900);
  glow.addColorStop(0, "rgba(245,184,61,0.10)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  // En-tête : le jeu, la manche.
  ctx.fillStyle = BRAND;
  ctx.font = "600 22px Outfit, Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(t("quiz.title").toUpperCase(), 48, 56);
  if (view.phase !== "intro" && view.phase !== "end") {
    ctx.textAlign = "right";
    ctx.fillStyle = MUTED;
    ctx.fillText(`${t("quiz.round")} ${view.round + 1} / ${view.total}`, W - 48, 56);
  }

  if (view.phase === "intro") {
    ctx.textAlign = "center";
    ctx.fillStyle = INK;
    ctx.font = "700 76px Outfit, Inter, sans-serif";
    ctx.fillText(t("quiz.title"), W / 2, H / 2 - 20);
    ctx.font = "500 30px Inter, sans-serif";
    ctx.fillStyle = MUTED;
    const left = Math.max(0, Math.ceil((view.endsAt - now) / 1000));
    ctx.fillText(`${t(`quiz.variant.${view.variant}` as Key)} · ${t("quiz.ready")} ${left || ""}`, W / 2, H / 2 + 44);
  } else if (view.phase === "end") {
    ctx.textAlign = "center";
    ctx.fillStyle = INK;
    ctx.font = "700 56px Outfit, Inter, sans-serif";
    ctx.fillText(t("quiz.end"), W / 2, 150);
    ctx.font = "500 30px Inter, sans-serif";
    view.players.slice(0, 8).forEach((p, i) => {
      const y = 240 + i * 52;
      ctx.fillStyle = p.id === you ? BRAND : INK;
      ctx.textAlign = "left";
      ctx.fillText(`${i + 1}.  ${p.name}`, W / 2 - 300, y);
      ctx.textAlign = "right";
      ctx.fillText(`${p.score} ${t("quiz.points")}`, W / 2 + 300, y);
    });
  } else if (view.clue) {
    const clue = view.clue;
    const span = Math.max(1, view.endsAt - view.startsAt);
    const progress = view.phase === "reveal" ? 1 : Math.min(1, Math.max(0, (now - view.startsAt) / span));
    const box = { x: 48, y: 88, w: 700, h: 560 };
    if (clue.image) {
      const img = image(clue.image);
      if (img) {
        if (clue.kind === "poster") drawPicture(ctx, img, box.x, box.y, box.w, box.h, view.phase === "reveal" ? 1 : Math.min(1, progress / 0.85), 1);
        else drawPicture(ctx, img, box.x, box.y, box.w, box.h, 1, view.phase === "reveal" ? 1 : 1 + 3.5 * (1 - Math.min(1, progress / 0.85)));
      }
    } else if (clue.text) {
      ctx.textAlign = "left";
      ctx.fillStyle = MUTED;
      ctx.font = "600 24px Inter, sans-serif";
      ctx.fillText(t(clue.kind === "cast" ? "quiz.clue.cast" : "quiz.clue.tagline"), box.x, box.y + 40);
      ctx.fillStyle = INK;
      if (clue.kind === "cast") {
        const names = clue.text.split("\n");
        const shown = view.phase === "reveal" ? names.length : Math.min(names.length, 1 + Math.floor(progress * names.length * 1.15));
        ctx.font = "600 44px Outfit, Inter, sans-serif";
        names.slice(0, shown).forEach((name, i) => ctx.fillText(name, box.x, box.y + 120 + i * 64));
      } else {
        ctx.font = "italic 500 44px Inter, sans-serif";
        wrap(ctx, `« ${clue.text} »`, box.x, box.y + 130, box.w, 60, 7);
      }
      if (clue.year) {
        ctx.fillStyle = MUTED;
        ctx.font = "500 28px Inter, sans-serif";
        ctx.fillText(String(clue.year), box.x, box.y + box.h - 10);
      }
    }
    // Les quatre propositions.
    clue.choices.forEach((title, i) => {
      const x = 790;
      const y = 120 + i * 128;
      const right = view.answer === i;
      const mine = choice === i;
      ctx.fillStyle = right ? "rgba(74,222,128,0.18)" : mine ? "rgba(245,184,61,0.16)" : "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.roundRect(x, y, 442, 104, 18);
      ctx.fill();
      if (right) {
        ctx.strokeStyle = GOOD;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      ctx.fillStyle = right ? GOOD : BRAND;
      ctx.font = "700 34px Outfit, Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(i + 1), x + 26, y + 64);
      ctx.fillStyle = INK;
      ctx.font = "600 29px Inter, sans-serif";
      wrap(ctx, title, x + 74, y + 46, 350, 34, 2);
    });
    // Le temps qui reste, et qui a répondu.
    if (view.phase === "question") {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(48, H - 34, W - 96, 8);
      ctx.fillStyle = BRAND;
      ctx.fillRect(48, H - 34, (W - 96) * (1 - progress), 8);
      if (view.players.length > 1) {
        ctx.fillStyle = MUTED;
        ctx.font = "500 22px Inter, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(`${view.answered.length} / ${view.players.length} ${t("quiz.answered")}`, W - 48, H - 50);
      }
    } else if (view.gains) {
      ctx.textAlign = "right";
      ctx.font = "600 24px Inter, sans-serif";
      view.players.slice(0, 4).forEach((p, i) => {
        ctx.fillStyle = p.id === you ? BRAND : INK;
        const gain = view.gains?.[p.id] ?? 0;
        ctx.fillText(`${p.name}  ${p.score}${gain ? `  (+${gain})` : ""}`, W - 48, H - 30 - (Math.min(4, view.players.length) - 1 - i) * 30);
      });
    }
  }
  quizTv.texture.needsUpdate = true;
}
