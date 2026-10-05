import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMountPoint, linkImageCache } from "../../server-boot/imageCache.mjs";

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cine-imgcache-"));
  const appDir = path.join(root, "app");
  const dataDir = path.join(appDir, "data");
  fs.mkdirSync(path.join(appDir, ".next"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { appDir, dataDir, cacheDir: path.join(appDir, ".next", "cache", "images"), target: path.join(dataDir, "image-cache") };
}

describe("le cache des affiches dans le volume de données", () => {
  it("relie le dossier de Next à data/image-cache, puis le reconnaît", () => {
    const t = tree();
    expect(linkImageCache({ appDir: t.appDir, dataDir: t.dataDir, mountinfo: "" })).toBe("lié");
    expect(fs.realpathSync(t.cacheDir)).toBe(fs.realpathSync(t.target));
    expect(linkImageCache({ appDir: t.appDir, dataDir: t.dataDir, mountinfo: "" })).toBe("déjà lié");
  });

  it("déplace dans le volume ce qu'un dossier réel contenait déjà, sans écraser le volume", () => {
    const t = tree();
    fs.mkdirSync(t.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(t.cacheDir, "a.webp"), "neuf");
    fs.mkdirSync(t.target, { recursive: true });
    fs.writeFileSync(path.join(t.target, "b.webp"), "ancien");
    linkImageCache({ appDir: t.appDir, dataDir: t.dataDir, mountinfo: "" });
    expect(fs.readFileSync(path.join(t.target, "a.webp"), "utf8")).toBe("neuf");
    expect(fs.readFileSync(path.join(t.target, "b.webp"), "utf8")).toBe("ancien");
    expect(fs.lstatSync(t.cacheDir).isSymbolicLink()).toBe(true);
  });

  it("ne touche jamais un dossier monté — le cache de l'installation avancée reste tel quel", () => {
    const t = tree();
    fs.mkdirSync(t.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(t.cacheDir, "x.webp"), "monté");
    const mountinfo = `1234 1 0:52 / ${t.cacheDir} rw,relatime - ext4 /dev/sda1 rw\n`;
    expect(linkImageCache({ appDir: t.appDir, dataDir: t.dataDir, mountinfo })).toBe("monté");
    expect(fs.lstatSync(t.cacheDir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(t.cacheDir, "x.webp"), "utf8")).toBe("monté");
  });

  it("lit les espaces échappés de mountinfo", () => {
    expect(isMountPoint("/a b/c", "1 1 0:1 / /a\\040b/c rw - ext4 x rw\n")).toBe(true);
    expect(isMountPoint("/a b", "1 1 0:1 / /a\\040b/c rw - ext4 x rw\n")).toBe(false);
  });
});
