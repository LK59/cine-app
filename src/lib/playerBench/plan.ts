import fs from "node:fs";

/**
 * Quels films le banc d'essai joue : ceux que le journal du lecteur désigne.
 *
 * Aucune liste écrite à la main — elle vieillirait, et elle nommerait la bibliothèque de quelqu'un
 * dans un dépôt public. Le journal sait déjà quels fichiers ont bloqué, sont partis au lecteur
 * serveur, ont eu des sauts lents ; et il sait décrire chacun (conteneur, image, plage dynamique).
 * Le plan prend d'abord les plus éprouvés, puis complète pour que chaque sorte de fichier soit là :
 * Dolby Vision, HDR10, SDR, MP4, 4K, épisode.
 */

export interface BenchCandidate {
  itemId: string;
  title: string;
  container: string;
  video: string;
  range: string;
  starts: number;
  stalls: number;
  errors: number;
  fallbacks: number;
  slowSeeks: number;
  unarrivedSeeks: number;
  lastSeen: string;
  score: number;
  /** Ce qui le distingue, en mots courts : « DV », « 4K », « MP4 », « blocages »… */
  tags: string[];
}

interface Line {
  timestamp?: string;
  kind?: string;
  itemId?: string;
  title?: string;
  container?: string;
  video?: string;
  range?: string;
  tookMs?: number;
  arrived?: boolean;
}

export function readLogLines(files: string[]): Line[] {
  const lines: Line[] = [];
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw) as Line);
      } catch {
        /* une ligne tronquée par une rotation */
      }
    }
  }
  return lines;
}

export function candidatesFrom(lines: Line[]): BenchCandidate[] {
  const byItem = new Map<string, BenchCandidate>();
  for (const line of lines) {
    if (!line.itemId || typeof line.itemId !== "string") continue;
    let c = byItem.get(line.itemId);
    if (!c) {
      c = {
        itemId: line.itemId,
        title: "",
        container: "?",
        video: "?",
        range: "?",
        starts: 0,
        stalls: 0,
        errors: 0,
        fallbacks: 0,
        slowSeeks: 0,
        unarrivedSeeks: 0,
        lastSeen: "",
        score: 0,
        tags: [],
      };
      byItem.set(line.itemId, c);
    }
    if (line.title) c.title = line.title;
    if (line.container) c.container = line.container;
    if (line.video) c.video = line.video;
    if (line.range) c.range = line.range;
    if (line.timestamp && line.timestamp > c.lastSeen) c.lastSeen = line.timestamp;
    switch (line.kind) {
      case "start":
        c.starts += 1;
        break;
      case "stall":
        c.stalls += 1;
        break;
      case "error":
        c.errors += 1;
        break;
      case "fallback":
        c.fallbacks += 1;
        break;
      case "seek":
        if (line.arrived === false) c.unarrivedSeeks += 1;
        else if (typeof line.tookMs === "number" && line.tookMs > 2500) c.slowSeeks += 1;
        break;
    }
  }

  const out: BenchCandidate[] = [];
  for (const c of byItem.values()) {
    // Un film jamais ouvert par ce lecteur n'a rien à dire : pas de titre, pas de description.
    if (!c.title || c.starts === 0) continue;
    c.score = c.errors * 5 + c.fallbacks * 4 + c.stalls * 3 + c.unarrivedSeeks * 2 + c.slowSeeks;
    c.tags = tagsOf(c);
    out.push(c);
  }
  return out.sort((a, b) => b.score - a.score || b.starts - a.starts || b.lastSeen.localeCompare(a.lastSeen));
}

function tagsOf(c: BenchCandidate): string[] {
  const tags: string[] = [];
  if (/DOVI/i.test(c.range)) tags.push("DV");
  else if (/HDR/i.test(c.range)) tags.push("HDR");
  else tags.push("SDR");
  if (/^\S+ 3840x/.test(c.video) || /x2160/.test(c.video)) tags.push("4K");
  if (c.container === "mp4") tags.push("MP4");
  if (/ — S\d+E\d+/.test(c.title)) tags.push("épisode");
  if (c.errors + c.fallbacks > 0) tags.push("erreurs");
  if (c.stalls > 0) tags.push("blocages");
  if (c.slowSeeks + c.unarrivedSeeks > 0) tags.push("sauts lents");
  return tags;
}

/**
 * Les films proposés d'office : la moitié parmi les plus éprouvés, le reste pour couvrir chaque
 * sorte de fichier que le journal connaît, puis les plus regardés.
 */
export function suggest(candidates: BenchCandidate[], count: number): string[] {
  const chosen: string[] = [];
  const take = (c: BenchCandidate | undefined) => {
    if (c && !chosen.includes(c.itemId) && chosen.length < count) chosen.push(c.itemId);
  };
  for (const c of candidates.filter((c) => c.score > 0).slice(0, Math.ceil(count / 2))) take(c);
  for (const tag of ["DV", "HDR", "SDR", "4K", "MP4", "épisode"]) {
    if (candidates.some((c) => chosen.includes(c.itemId) && c.tags.includes(tag))) continue;
    take(candidates.find((c) => c.tags.includes(tag)));
  }
  for (const c of [...candidates].sort((a, b) => b.starts - a.starts)) take(c);
  return chosen;
}
