import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { epubProblem } from "@/lib/books/epubCheck";

/**
 * Un livre qu'on ne lira jamais le dit (DECISIONS.md §127) : protégé par un DRM, ou pas un EPUB du tout.
 * L'obfuscation des polices (un `encryption.xml` qui ne touche que des polices) n'est pas un DRM.
 */
function zip(files: Record<string, string>): Blob {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Blob([Buffer.concat([...locals, cd, eocd])]);
}

const base = { mimetype: "application/epub+zip", "META-INF/container.xml": "<container/>", "OEBPS/c1.xhtml": "<html/>" };
const encryption = (uri: string) =>
  `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData><CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`;

describe("ce qu'un fichier dit de lui-même", () => {
  it("un EPUB ordinaire : rien n'empêche d'essayer", async () => {
    expect(await epubProblem(zip(base))).toBeNull();
  });
  it("pas une archive : un PDF, une page d'erreur", async () => {
    expect(await epubProblem(new Blob(["%PDF-1.7 ..."]))).toBe("not-epub");
    expect(await epubProblem(new Blob(["<html>Erreur</html>"]))).toBe("not-epub");
  });
  it("un DRM : Adobe (rights.xml), Apple (sinf.xml), des chapitres chiffrés", async () => {
    expect(await epubProblem(zip({ ...base, "META-INF/rights.xml": "<rights/>" }))).toBe("drm");
    expect(await epubProblem(zip({ ...base, "META-INF/sinf.xml": "<sinf/>" }))).toBe("drm");
    expect(await epubProblem(zip({ ...base, "META-INF/encryption.xml": encryption("OEBPS/c1.xhtml") }))).toBe("drm");
  });
  it("des polices obfusquées seulement : lisible", async () => {
    expect(await epubProblem(zip({ ...base, "META-INF/encryption.xml": encryption("OEBPS/fonts/Literata.otf") }))).toBeNull();
  });
});
