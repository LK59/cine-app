/**
 * Ce qu'on peut dire d'un fichier avant de le donner à foliate-js (DECISIONS.md §127) : un livre qu'on
 * ne pourra jamais lire doit le dire clairement, pas « Ce livre n'a pas pu être ouvert ».
 *
 * - `not-epub` : ce n'est pas une archive zip (un PDF, un fichier tronqué, une page d'erreur).
 * - `drm` : le texte est chiffré — Adobe ADEPT ou FairPlay d'Apple (`META-INF/rights.xml`,
 *   `sinf.xml`), ou un `encryption.xml` qui chiffre des chapitres. Un `encryption.xml` qui ne touche
 *   que des polices (l'obfuscation IDPF ou Adobe, courante et sans DRM) n'empêche rien.
 *
 * Lu sur le répertoire central du zip seulement (la fin du fichier), et `encryption.xml` décompressé
 * par le navigateur (`DecompressionStream`) ; s'il ne sait pas le faire, on ne conclut rien.
 */

export type EpubProblem = "not-epub" | "drm";

export class EpubProblemError extends Error {
  constructor(readonly problem: EpubProblem) {
    super(problem === "drm" ? "livre protégé (DRM)" : "pas un EPUB");
    this.name = "EpubProblemError";
  }
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function entries(buf: Uint8Array): Entry[] | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const size = view.getUint32(eocd + 12, true);
  let p = view.getUint32(eocd + 16, true);
  const end = Math.min(buf.length, p + size);
  const out: Entry[] = [];
  const decoder = new TextDecoder();
  while (p + 46 <= end && view.getUint32(p, true) === 0x02014b50) {
    const nameLen = view.getUint16(p + 28, true);
    out.push({
      name: decoder.decode(buf.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      localOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return out;
}

async function text(buf: Uint8Array, e: Entry): Promise<string | null> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const at = e.localOffset;
  if (at + 30 > buf.length || view.getUint32(at, true) !== 0x04034b50) return null;
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = buf.slice(start, start + e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8 || typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

/** Le problème d'un fichier, ou `null` quand rien n'empêche d'essayer. */
export async function epubProblem(file: Blob): Promise<EpubProblem | null> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return "not-epub";
  const list = entries(buf);
  if (!list) return "not-epub";
  const names = new Set(list.map((e) => e.name));
  if (names.has("META-INF/rights.xml") || names.has("META-INF/sinf.xml")) return "drm";
  const enc = list.find((e) => e.name === "META-INF/encryption.xml");
  if (!enc) return null;
  const xml = await text(buf, enc);
  if (!xml) return null;
  // Les adresses chiffrées ; des polices seules (obfuscation), ce n'est pas un DRM.
  const uris = [...xml.matchAll(/CipherReference[^>]*URI\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].toLowerCase());
  return uris.some((u) => /\.(x?html?|xml|ncx|opf)$/.test(u)) ? "drm" : null;
}
