import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const lire = (f: string) => fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");

/**
 * Ce qu'on parcourt ne s'enfonce pas au premier contact (23/09/2026).
 *
 * Les rangées du téléphone portaient `active:scale-95` sans délai : poser le doigt pour faire
 * défiler enfonçait l'affiche, et la propriété `scale` de Tailwind se cumulait à l'enfoncement de
 * base des boutons. `pressable` retarde l'aller de 70 ms, ce qu'un balayage n'atteint jamais — voir
 * globals.css. Et une ligne pleine largeur s'allume au lieu de glisser sous le doigt.
 */
describe("appui pendant un défilement, sur téléphone", () => {
  it("les cartes des rangées passent par `pressable`", () => {
    const src = lire("src/components/cinema/mobile/CinemaMobileClient.tsx");
    expect(src).not.toMatch(/(CONTINUE_WIDTH|POSTER_WIDTH)\}[^`]*active:scale-95/);
    expect(src.match(/\$\{(CONTINUE_WIDTH|POSTER_WIDTH)\} pressable/g)?.length).toBe(4);
  });

  it("la ligne d'épisode s'allume et ne s'enfonce pas", () => {
    const src = lire("src/components/cinema/mobile/CinemaMobileDetail.tsx");
    expect(src).not.toContain('className="flex w-full gap-3 text-left active:scale-95"');
    expect(src).toMatch(/className="flex w-full gap-3 [^"]*active:transform-none active:bg-white\/10/);
  });

  it("les lignes du rail et des épisodes du bureau s'allument sans s'enfoncer", () => {
    // La règle est écrite dans globals.css (« Creux pour ce qu'on saisit, fond pour ce qu'on
    // parcourt »), mais l'enfoncement de base des boutons s'appliquait quand même, et d'un coup :
    // leur `transition-colors` n'anime pas la transformation (23/09/2026).
    for (const f of ["src/components/player/PlayerRail.tsx", "src/components/cinema/CinemaEpisodeBrowser.tsx"]) {
      const src = lire(f);
      expect([f, src.includes("active:bg-white/15 active:delay-75")]).toEqual([f, true]);
      expect([f, src.match(/active:transform-none active:bg-white\/15/g)?.length]).toEqual([
        f,
        src.match(/active:bg-white\/15 active:delay-75/g)?.length,
      ]);
    }
  });
});

