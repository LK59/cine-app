import { describe, it, expect, vi } from "vitest";
import { brightLuminance, DARK_LUMINANCE } from "@/lib/logoLuminance";
import type { TmdbImage } from "@/lib/clients/tmdb";

vi.mock("@/lib/server-cache", () => ({
  withPersistentCache: (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}));

/**
 * Un logo trop sombre pour nos fonds n'est jamais choisi quand un autre se lit (09/10/2026) : « The
 * End of the F***ing World » avait deux logos français identiques, un noir et un blanc, à égalité, et
 * le noir — invisible sur la fiche comme dans le lecteur — l'emportait.
 */
const logo = (file_path: string, iso_639_1: string | null, vote_average = 0) => ({ file_path, iso_639_1, vote_average }) as TmdbImage;
const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];

describe("la luminosité d'un logo", () => {
  it("juge noir un logo noir, lisible un logo blanc ou rouge", () => {
    expect(brightLuminance(Uint8Array.from([...px(0, 0, 0), ...px(0, 0, 0)]))!).toBeLessThan(DARK_LUMINANCE);
    expect(brightLuminance(Uint8Array.from([...px(255, 255, 255)]))!).toBeGreaterThan(DARK_LUMINANCE);
    expect(brightLuminance(Uint8Array.from([...px(200, 0, 1)]))!).toBeGreaterThan(DARK_LUMINANCE);
  });

  it("lit la partie claire : un logo noir cerné de blanc se lit", () => {
    const pixels = [...Array(8)].flatMap(() => px(0, 0, 0)).concat([...Array(2)].flatMap(() => px(255, 255, 255)));
    expect(brightLuminance(Uint8Array.from(pixels))!).toBeGreaterThan(DARK_LUMINANCE);
  });

  it("ignore les pixels transparents, et ne dit rien d'une image vide", () => {
    expect(brightLuminance(Uint8Array.from([...px(255, 255, 255, 0), ...px(0, 0, 0)]))!).toBeLessThan(DARK_LUMINANCE);
    expect(brightLuminance(Uint8Array.from(px(255, 255, 255, 0)))).toBeNull();
  });
});

describe("le choix du logo", () => {
  it("prend le logo blanc quand le noir lui est égal (le cas de la série)", async () => {
    const { pickLogo } = await import("@/lib/title-art");
    const logos = [logo("/fEBiy.png", "fr"), logo("/kEM3B.png", "fr"), logo("/rouge.png", "en")];
    const dark = async (p: string) => p === "/fEBiy.png";
    expect(await pickLogo(logos, dark)).toBe("https://image.tmdb.org/t/p/w500/kEM3B.png");
  });

  it("garde l'ordre des langues : l'anglais seulement si aucun logo français ne se lit", async () => {
    const { pickLogo } = await import("@/lib/title-art");
    const logos = [logo("/fr-noir.png", "fr", 9), logo("/en.png", "en", 1)];
    expect(await pickLogo(logos, async (p) => p === "/fr-noir.png")).toBe("https://image.tmdb.org/t/p/w500/en.png");
    expect(await pickLogo(logos, async () => false)).toBe("https://image.tmdb.org/t/p/w500/fr-noir.png");
  });

  it("une mesure impossible ne retire pas de logo", async () => {
    const { pickLogo } = await import("@/lib/title-art");
    expect(await pickLogo([logo("/fr.png", "fr")], async () => null)).toBe("https://image.tmdb.org/t/p/w500/fr.png");
  });

  it("aucun logo plutôt qu'un logo invisible : le titre écrit s'affiche", async () => {
    const { pickLogo } = await import("@/lib/title-art");
    expect(await pickLogo([logo("/a.png", "fr"), logo("/b.png", "en")], async () => true)).toBeNull();
  });

  it("ne mesure que ce qu'il faut : s'arrête au premier lisible", async () => {
    const { pickLogo } = await import("@/lib/title-art");
    const isDark = vi.fn(async () => false);
    await pickLogo([logo("/1.png", "fr", 5), logo("/2.png", "fr", 1), logo("/3.png", "en")], isDark);
    expect(isDark).toHaveBeenCalledTimes(1);
  });
});
