import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";

/**
 * Chaque icône et chaque écran de lancement que l'application réclame existe dans `public/`, aux
 * dimensions qu'elle annonce (logo Laterna, 23/10/2026).
 *
 * Un fichier manquant ne casse rien de visible ici : le navigateur se rabat sur une icône générique,
 * iOS sur un écran blanc, Android sur un carré gris dans la barre d'état — et rien n'apparaît dans un
 * journal. Les références sont lues dans leurs propres sources (manifeste, `layout.tsx`, `sw.js`, les
 * envois de notifications, les pages qui affichent l'icône), pas recopiées ici.
 */

/** Largeur, hauteur et type de couleur, lus dans l'en-tête IHDR. */
function pngInfo(path: string) {
  const png = readFileSync(path);
  expect(png.subarray(0, 8), path).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.subarray(12, 16).toString("latin1"), path).toBe("IHDR");
  // 2 : RVB sans alpha ; 6 : RVBA.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] };
}

const read = (p: string) => readFileSync(p, "utf8");
const publicPath = (url: string) => `public${url}`;

const manifest = JSON.parse(read("public/manifest.json")) as { icons: { src: string; sizes: string; purpose?: string }[] };
const layout = read("src/app/layout.tsx");
const sw = read("public/sw.js");

describe("icônes et écrans de lancement référencés", () => {
  it("le manifeste : chaque icône existe à la taille déclarée", () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngInfo(publicPath(icon.src)), icon.src).toMatchObject({ width: w, height: h });
    }
  });

  it("l'icône maskable est un fichier à part, opaque", () => {
    // Une icône maskable remplit tout son carré (le système la découpe) : le dessin de l'icône
    // « any », aux coins transparents, y perdait ses bords et prenait un fond noir.
    const maskable = manifest.icons.filter((i) => i.purpose === "maskable");
    const any = manifest.icons.filter((i) => i.purpose !== "maskable").map((i) => i.src);
    expect(maskable).toHaveLength(1);
    expect(any).not.toContain(maskable[0].src);
    expect(pngInfo(publicPath(maskable[0].src)).colorType).toBe(2);
  });

  it("layout.tsx : favicon, icône Apple (180, opaque) et chaque écran de lancement", () => {
    const icons = [...layout.matchAll(/\{ url: "([^"]+)"(?:, sizes: "(\d+)x(\d+)")?, type: "([^"]+)" \}/g)];
    expect(icons.length).toBeGreaterThanOrEqual(3);
    for (const [, url, w, , type] of icons) {
      expect(existsSync(publicPath(url)), url).toBe(true);
      if (type === "image/png") expect(pngInfo(publicPath(url)), url).toMatchObject({ width: Number(w), height: Number(w) });
    }
    expect(pngInfo("public/apple-touch-icon.png")).toEqual({ width: 180, height: 180, colorType: 2 });

    const declares = [...layout.matchAll(/\{ width: (\d+), height: (\d+), dpr: (\d+) \}/g)].map((m) => m.slice(1).map(Number));
    expect(declares.length).toBeGreaterThan(15);
    for (const [width, height, dpr] of declares) {
      for (const [w, h] of [[width * dpr, height * dpr], [height * dpr, width * dpr]]) {
        expect(pngInfo(`public/splash/apple-splash-${w}-${h}.png`)).toMatchObject({ width: w, height: h });
      }
    }
  });

  it("sw.js : ce qu'il met en réserve et ce que portent ses notifications", () => {
    const precache = JSON.parse(sw.match(/const PRECACHE = (\[[^\]]+\]);/)![1].replace(/'/g, '"')) as string[];
    const refs = [...precache, ...[...sw.matchAll(/(?:icon|badge): (?:data\.icon \?\? )?"(\/[^"]+)"/g)].map((m) => m[1])];
    expect(refs).toContain("/badge-96.png");
    for (const ref of refs) expect(existsSync(publicPath(ref)), ref).toBe(true);
  });

  it("les notifications envoyées par le serveur et la page : icône et badge existent", () => {
    const sources = ["src/lib/push.ts", "src/app/api/push/test/route.ts", "src/components/SSENotifier.tsx"];
    const refs = sources.flatMap((s) => [...read(s).matchAll(/(?:icon|badge): (?:payload\.icon \?\? )?"(\/[^"]+\.png)"/g)].map((m) => m[1]));
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) expect(existsSync(publicPath(ref)), ref).toBe(true);
    // Le badge Android est une silhouette : seul son alpha compte, il lui faut donc un alpha.
    expect(pngInfo("public/badge-96.png")).toEqual({ width: 96, height: 96, colorType: 6 });
  });

  it("les pages qui affichent l'icône de l'application", () => {
    const pages = ["src/app/login/page.tsx", "src/components/shareGuest/ShareRedeemForm.tsx", "src/components/player/PlayerOnboarding.tsx"];
    for (const page of pages) {
      const srcs = [...read(page).matchAll(/<img src="(\/[^"]+\.png)"/g)].map((m) => m[1]);
      expect(srcs.length, page).toBeGreaterThan(0);
      for (const src of srcs) expect(existsSync(publicPath(src)), src).toBe(true);
    }
  });

  it("les SVG servis sont ceux des sources de tools/brand (générés, jamais retouchés)", () => {
    expect(read("public/icon.svg")).toBe(read("tools/brand/icon.svg"));
    expect(read("public/icon-flat.svg")).toBe(read("tools/brand/icon-flat.svg"));
    expect(read("public/favicon.svg")).toBe(read("tools/brand/icon-32.svg"));
  });

  it("chaque image servie hors session est dans la liste du proxy", () => {
    const proxy = read("src/proxy.ts");
    const bloc = proxy.slice(proxy.indexOf("const ACTIFS_PUBLICS = ["), proxy.indexOf("];", proxy.indexOf("const ACTIFS_PUBLICS = [")));
    const actifs = [...bloc.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const url of [...manifest.icons.map((i) => i.src), "/badge-96.png", "/favicon-32.png", "/apple-touch-icon.png", "/icon.svg"]) {
      expect(actifs.some((a) => url.slice(1).startsWith(a)), url).toBe(true);
    }
  });
});
