// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { ProgressFill } from "@/components/cinema/ProgressFill";

/**
 * La progression se remplit à l'arrivée, et glisse quand elle change (23/09/2026) — une écriture
 * pour les trois barres, qui la dessinaient chacune à sa façon.
 */
afterEach(cleanup);
const lire = (f: string) => fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");

describe("ProgressFill", () => {
  it("porte sa valeur et l'animation d'arrivée", () => {
    const { container } = render(<ProgressFill percent={42} />);
    const fill = container.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("42%");
    expect(fill.className).toContain("progress-fill");
  });

  it("se remplit par une échelle, et glisse en largeur quand la valeur change", () => {
    const css = lire("src/app/globals.css");
    expect(css).toMatch(/@keyframes progress-fill \{\s*from \{ transform: scaleX\(0\); \}/);
    expect(css).toMatch(/\.progress-fill \{[^}]*transform-origin: left;[^}]*transition: width/);
  });

  it.each([
    "src/components/cinema/CinemaClient.tsx",
    "src/components/cinema/mobile/CinemaMobileClient.tsx",
    "src/components/cinema/CinemaEpisodeProgress.tsx",
  ])("%s passe par ProgressFill", (f) => {
    const src = lire(f);
    expect(src).toContain("<ProgressFill percent={");
    expect(src).not.toMatch(/className="h-full bg-accent-500" style=\{\{ width:/);
  });
});
