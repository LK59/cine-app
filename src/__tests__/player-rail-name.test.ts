import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// « Cine » seul était resté en haut du rail depuis sa création (relevé le 23/09/2026) : le nom de
// l'application est le même partout — barre latérale de la gestion, installation, rail.
describe("le rail du cinéma", () => {
  it("porte le nom entier de l'application", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/player/PlayerRail.tsx"), "utf8");
    expect(src).toMatch(/>\s*Cine App\s*</);
    expect(src).not.toMatch(/>\s*Cine\s*</);
  });
});
