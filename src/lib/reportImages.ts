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
/** Par image. Une photo d'iPhone récent fait 3 à 8 Mo ; une capture d'écran bien moins. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Par envoi (signalement ou commentaire). */
export const MAX_IMAGES = 6;

const EXTENSIONS = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?|jxl|ico|svg)$/i;

/** Une image, par son type annoncé ou, à défaut, par son extension — certains navigateurs n'en disent rien. */
export function looksLikeImage(file: { type: string; name: string }): boolean {
  return file.type.startsWith("image/") || EXTENSIONS.test(file.name);
}

function extensionOf(file: { type: string; name: string }): string {
  const fromName = file.name.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const fromType = file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "");
  return fromType || "bin";
}

/**
 * Enregistre une image : l'original, et une version d'affichage si elle peut être produite.
 * `shown` est ce que le navigateur a lui-même converti (un HEIC devenu JPEG), s'il l'a fait.
 */
export async function saveReportImage(reportId: number, messageId: number | null, original: File, shown: File | null): Promise<ReportImage> {
  const dir = path.join(REPORTS_DIR(), String(reportId));
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const originalName = `${id}.orig.${extensionOf(original)}`;
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
    mime: original.type || "application/octet-stream",
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

/** Les images d'un envoi, lues dans un formulaire : `images` et, à côté, `shown` au même rang. */
export function imagesFromForm(form: FormData): { original: File; shown: File | null }[] | string {
  const originals = form.getAll("images").filter((v): v is File => typeof v !== "string");
  const shown = form.getAll("shown");
  if (originals.length > MAX_IMAGES) return `${MAX_IMAGES} images au plus`;
  const out: { original: File; shown: File | null }[] = [];
  for (let i = 0; i < originals.length; i++) {
    const original = originals[i];
    if (!looksLikeImage(original)) return `« ${original.name} » n'est pas une image`;
    if (original.size > MAX_IMAGE_BYTES) return `« ${original.name} » dépasse 25 Mo`;
    const converted = shown[i];
    out.push({ original, shown: converted && typeof converted !== "string" && converted.size > 0 ? converted : null });
  }
  return out;
}
