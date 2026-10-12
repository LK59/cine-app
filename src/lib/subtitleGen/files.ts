import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { isJellyfinId } from "@/lib/jellyfinPath";

/**
 * Le fichier final d'une tâche : `data/subtitles/<itemId>/<jobId>.<langue>.srt` et son double
 * WebVTT, écrits quand toutes les lignes sont faites (DECISIONS.md §69).
 *
 * La copie de `data/` est la source de vérité : c'est elle qu'on envoie à Jellyfin, elle qu'on sert
 * si l'envoi échoue pour de bon, et elle qui survit à un sous-titre retiré de la bibliothèque.
 * Les minutages sont ceux de la source, à la milliseconde.
 */

export interface FinalCue {
  start: number;
  end: number;
  text: string;
}

function stamp(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: FinalCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: FinalCue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")}`;
}

/**
 * L'empreinte du texte produit — de quoi reconnaître **avec certitude** notre fichier une fois
 * que Jellyfin le relit (la suite des répliques, sans les minutages que sa conversion arrondit).
 */
export function textHash(texts: string[]): string {
  const h = crypto.createHash("sha256");
  for (const t of texts) h.update(`${t.replace(/\s+/g, " ").trim()}\n`);
  return h.digest("hex").slice(0, 32);
}

const JOB_ID = /^[0-9a-f]{32}$/;

export function finalPaths(itemId: string, jobId: string, target: string): { srt: string; vtt: string } {
  // Les deux identifiants viennent de la base, mais un chemin se construit toujours sur des formes
  // vérifiées : un `..` glissé ici écrirait ailleurs que dans `data/subtitles`.
  if (!isJellyfinId(itemId) || !JOB_ID.test(jobId) || !/^[a-z]{2}$/.test(target)) throw new Error("identifiants invalides");
  const dir = path.join(DATA_DIR, "subtitles", itemId);
  return { srt: path.join(dir, `${jobId}.${target}.srt`), vtt: path.join(dir, `${jobId}.${target}.vtt`) };
}

export function writeFinal(itemId: string, jobId: string, target: string, cues: FinalCue[]): { srt: string; hash: string } {
  const paths = finalPaths(itemId, jobId, target);
  fs.mkdirSync(path.dirname(paths.srt), { recursive: true });
  const srt = toSrt(cues);
  fs.writeFileSync(paths.srt, srt, "utf8");
  fs.writeFileSync(paths.vtt, toVtt(cues), "utf8");
  return { srt, hash: textHash(cues.map((c) => c.text)) };
}

export function readFinal(itemId: string, jobId: string, target: string, kind: "srt" | "vtt"): string | null {
  try {
    return fs.readFileSync(finalPaths(itemId, jobId, target)[kind], "utf8");
  } catch {
    return null;
  }
}
