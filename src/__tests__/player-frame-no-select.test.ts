import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Rien à sélectionner dans le lecteur, vidéo et sous-titres compris (20/10/2026) : sur iPhone, une
// rafale de touchers hors des commandes lançait la sélection d'iOS sur toute la page, et plus aucun
// bouton ne répondait. Les trois lecteurs portent la même marque, et une seule règle la sert.
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("le cadre des lecteurs ne sélectionne rien", () => {
  it.each(["src/components/ExperimentalPlayerHost.tsx", "src/components/PlayerHost.tsx", "src/components/offline/OfflinePlayerHost.tsx"])(
    "%s marque son cadre",
    (file) => {
      expect(read(file)).toMatch(/data-player-frame/);
    }
  );

  it("la règle coupe la sélection et la bulle d'iOS, et la rend aux champs de saisie", () => {
    const css = read("src/app/globals.css");
    const rule = css.slice(css.indexOf("[data-player-frame] {"));
    expect(rule).toMatch(/^\[data-player-frame\] \{\s*-webkit-touch-callout: none;\s*-webkit-user-select: none;\s*user-select: none;/);
    expect(css).toMatch(/\[data-player-frame\] textarea \{\s*user-select: text;/);
  });
});
