// Les captures jointes à un signalement, sur le disque (`data/reports/<id>/`).
//
// Tout format d'image est accepté, pour que « joindre une capture » marche toujours : le fichier
// reçu est gardé tel quel, et une version WebP (orientée selon l'EXIF, bornée à 2560 px) sert à
// l'affichage. Le HEIC des iPhone, que `sharp` ne sait pas lire, est converti en JPEG par le
// navigateur avant l'envoi (voir `prepareReportImage`) : Safari, lui, sait le décoder. Si rien n'a
// pu le lire, l'original reste là, téléchargeable, et l'écran le dit au lieu d'afficher une image
// cassée.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { reportsDb, type ReportImage } from "@/lib/db";
import { logError } from "@/lib/logger";

export const REPORTS_DIR = () => path.join(DATA_DIR, "reports");
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "@/lib/reportLimits";
export { MAX_IMAGE_BYTES, MAX_IMAGES };

/**
 * Les formats acceptés, et le type sous lequel chacun est servi. Le type vient d'ici, jamais du
 * navigateur qui a envoyé le fichier : servir le type annoncé laissait passer une page HTML ou un
 * SVG porteur de script sous un nom de capture, ouverts ensuite dans la session de
 * l'administrateur par « ouvrir l'original » (24/09/2026). Pas de SVG : c'est un document, pas une
 * image. La liste affichée à l'écran (`report.ui.imagesHint`) doit rester celle-ci.
 */
const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  jxl: "image/jxl",
};
const FROM_TYPE: Record<string, string> = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([ext, type]) => [type, ext]));

/** L'extension sûre d'un fichier : par son nom, ou — certains navigateurs n'en donnent pas — par son type. */
function extensionOf(file: { type: string; name: string }): string | null {
  const fromName = file.name.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (fromName && fromName in IMAGE_TYPES) return fromName;
  if (fromName) return null;
  return FROM_TYPE[file.type.toLowerCase()] ?? null;
}

export function looksLikeImage(file: { type: string; name: string }): boolean {
  return extensionOf(file) !== null;
}

/** Le type d'un fichier enregistré, par son extension — celle que `saveReportImage` a choisie. */
export function storedImageType(name: string): string {
  return IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/**
 * Enregistre une image : l'original, et une version d'affichage si elle peut être produite.
 * `shown` est ce que le navigateur a lui-même converti (un HEIC devenu JPEG), s'il l'a fait.
 */
export async function saveReportImage(reportId: number, messageId: number | null, original: File, shown: File | null): Promise<ReportImage> {
  const dir = path.join(REPORTS_DIR(), String(reportId));
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  // Appelé après `looksLikeImage` : l'extension existe toujours.
  const originalName = `${id}.orig.${extensionOf(original) ?? "bin"}`;
  const originalBytes = Buffer.from(await original.arrayBuffer());
  fs.writeFileSync(path.join(dir, originalName), originalBytes);

  let file: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  // `sharp` lit presque tout ; ce qu'il ne lit pas, le navigateur l'a peut-être déjà converti.
  for (const source of [originalBytes, shown ? Buffer.from(await shown.arrayBuffer()) : null]) {
    if (!source) continue;
    try {
      const { default: sharp } = await import("sharp");
      const { data, info } = await sharp(source, { failOn: "none", limitInputPixels: 100_000_000 })
        .rotate()
        .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      file = `${id}.webp`;
      fs.writeFileSync(path.join(dir, file), data);
      width = info.width;
      height = info.height;
      break;
    } catch (error) {
      if (source === originalBytes && shown) continue;
      logError("reports", error, { where: "conversion d'une capture", reportId, name: original.name, type: original.type });
    }
  }

  return reportsDb.addImage({
    reportId,
    messageId,
    file,
    original: originalName,
    mime: storedImageType(originalName),
    originalName: original.name.slice(0, 200) || null,
    width,
    height,
    bytes: originalBytes.byteLength,
  });
}

/** Le chemin d'un fichier d'un signalement — jamais en dehors de son dossier. */
export function reportFilePath(reportId: number, name: string): string | null {
  if (!/^[0-9a-f-]{36}(\.orig)?\.[a-z0-9]{2,5}$/i.test(name)) return null;
  return path.join(REPORTS_DIR(), String(reportId), name);
}

/** Un refus d'images : un code, que l'écran traduit (`report.errors.*`), et le détail pour le journal. */
export interface ImageRefusal {
  code: "tooMany" | "notImage" | "tooLarge";
  detail: string;
}

/** Les images d'un envoi, lues dans un formulaire : `images` et, à côté, `shown` au même rang. */
export function imagesFromForm(form: FormData): { original: File; shown: File | null }[] | ImageRefusal {
  const originals = form.getAll("images").filter((v): v is File => typeof v !== "string");
  const shown = form.getAll("shown");
  if (originals.length > MAX_IMAGES) return { code: "tooMany", detail: `${MAX_IMAGES} images au plus` };
  const out: { original: File; shown: File | null }[] = [];
  for (let i = 0; i < originals.length; i++) {
    const original = originals[i];
    if (!looksLikeImage(original)) return { code: "notImage", detail: `« ${original.name} » n'est pas une image` };
    if (original.size > MAX_IMAGE_BYTES) return { code: "tooLarge", detail: `« ${original.name} » dépasse 25 Mo` };
    const converted = shown[i];
    out.push({ original, shown: converted && typeof converted !== "string" && converted.size > 0 ? converted : null });
  }
  return out;
}
