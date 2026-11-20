import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { inputPixelLimit } from "@/lib/reportImages";
import { clampDim, LOGIN_BACKGROUND_DEFAULT_DIM, LOGIN_BACKGROUND_MAX_BYTES, type LoginBackground } from "@/lib/loginBackgroundShared";

export type { LoginBackground };
export { LOGIN_BACKGROUND_MAX_BYTES };

/**
 * L'image de fond des écrans de connexion (20/11/2026, DECISIONS §199) : la page de connexion et celle du
 * code de partage. Une image que l'administrateur envoie lui-même — jamais un mur d'affiches de la
 * bibliothèque : ces pages sont publiques, et un mur montrerait à n'importe qui ce que contient la
 * bibliothèque, titres masqués par les tags bloqués compris (§54), en une rafale de requêtes que CrowdSec
 * prend pour une exploration.
 *
 * Rangée dans `DATA_DIR/branding/` : la version d'affichage (`login-bg.webp`, 2 560 px au plus), l'original
 * tel qu'envoyé, et `login-bg.json` — sa version (une empreinte du WebP, qui nomme l'adresse et la rend
 * immuable) et le voile posé dessus. Sans fichier, les écrans restent tout noirs (le choix du 10/10/2026).
 */

const dir = () => path.join(DATA_DIR, "branding");
const webpPath = () => path.join(dir(), "login-bg.webp");
const metaPath = () => path.join(dir(), "login-bg.json");

/** L'image en place, ou `null`. Lue à chaque page : un `stat` et un petit JSON. Jamais une erreur. */
export function loginBackground(): LoginBackground | null {
  try {
    if (!fs.existsSync(webpPath())) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")) as Partial<LoginBackground>;
    if (typeof meta.v !== "string" || !/^[0-9a-f]{12}$/.test(meta.v)) return null;
    return { v: meta.v, dim: clampDim(meta.dim) };
  } catch {
    return null;
  }
}

/** Les octets du WebP, pour la route publique. */
export function loginBackgroundBytes(): Buffer | null {
  try {
    return fs.readFileSync(webpPath());
  } catch {
    return null;
  }
}

export type LoginBackgroundRefusal = "tooLarge" | "notImage";

/**
 * Enregistre une nouvelle image : tournée selon son EXIF, réduite à 2 560 px, en WebP. Ce que `sharp` ne
 * sait pas lire (un HEIC envoyé tel quel) est refusé — Safari convertit lui-même le HEIC en JPEG quand le
 * champ n'accepte que JPEG, PNG et WebP.
 */
export async function saveLoginBackground(bytes: Buffer, originalName: string): Promise<LoginBackground | LoginBackgroundRefusal> {
  if (bytes.byteLength > LOGIN_BACKGROUND_MAX_BYTES) return "tooLarge";
  let webp: Buffer;
  try {
    const { default: sharp } = await import("sharp");
    const limitInputPixels = inputPixelLimit((await sharp(bytes, { failOn: "none" }).metadata()).format);
    webp = await sharp(bytes, { failOn: "none", limitInputPixels })
      .rotate()
      .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return "notImage";
  }
  fs.mkdirSync(dir(), { recursive: true });
  for (const f of fs.readdirSync(dir())) if (f.startsWith("login-bg.orig.")) fs.rmSync(path.join(dir(), f), { force: true });
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(originalName)?.[1] ?? "bin").toLowerCase();
  fs.writeFileSync(path.join(dir(), `login-bg.orig.${ext}`), bytes);
  fs.writeFileSync(webpPath(), webp);
  const previous = loginBackground();
  const meta: LoginBackground = { v: createHash("sha256").update(webp).digest("hex").slice(0, 12), dim: previous?.dim ?? LOGIN_BACKGROUND_DEFAULT_DIM };
  fs.writeFileSync(metaPath(), JSON.stringify(meta));
  return meta;
}

/** Change le voile de l'image en place ; `null` s'il n'y en a pas. */
export function setLoginBackgroundDim(dim: unknown): LoginBackground | null {
  const current = loginBackground();
  if (!current) return null;
  const meta = { ...current, dim: clampDim(dim) };
  fs.writeFileSync(metaPath(), JSON.stringify(meta));
  return meta;
}

/** Retire l'image : les écrans redeviennent noirs. */
export function removeLoginBackground(): void {
  if (!fs.existsSync(dir())) return;
  for (const f of fs.readdirSync(dir())) if (f.startsWith("login-bg.")) fs.rmSync(path.join(dir(), f), { force: true });
}
