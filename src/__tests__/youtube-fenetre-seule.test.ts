import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * YouTube : la fenêtre du bouton « Bande-annonce », et rien d'autre (13/10/2026, DECISIONS.md §55).
 *
 * La bande-annonce de fond de la bannière avait été éteinte sans être retirée : son composant, le
 * chargeur de l'API iframe et les hôtes YouTube de la CSP restaient là, prêts à revenir par un seul
 * import. Ce test lit la source et la politique servie, parce que la faute à attraper est un retour
 * silencieux — rien de ce qu'on voit à l'écran ne le dirait.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

async function csp(): Promise<Record<string, string>> {
  const config = createRequire(import.meta.url)(resolve("next.config.js")) as {
    headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
  };
  const rules = await config.headers();
  const value = rules
    .flatMap((r) => r.headers)
    .find((h) => h.key === "Content-Security-Policy" && h.value.includes("frame-src"))?.value;
  if (!value) throw new Error("CSP introuvable dans next.config.js");
  return Object.fromEntries(
    value.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d])
  );
}

describe("YouTube dans l'application", () => {
  it("ne garde aucun lecteur de bande-annonce de fond", () => {
    expect(existsSync("src/components/cinema/CinemaTrailerBackdrop.tsx")).toBe(false);
    expect(existsSync("src/lib/loadYoutubeIframeApi.ts")).toBe(false);
    const offenders = sources("src").filter((file) =>
      /YT\.Player|iframe_api|onYouTubeIframeAPIReady|loadYoutubeIframeApi|CinemaTrailerBackdrop/.test(withoutComments(readFileSync(file, "utf8")))
    );
    expect(offenders).toEqual([]);
  });

  it("n'ouvre YouTube que dans la fenêtre du bouton, en youtube-nocookie", () => {
    const embeds = sources("src").filter((file) => /youtube(-nocookie)?\.com/.test(withoutComments(readFileSync(file, "utf8"))));
    expect(embeds).toEqual([join("src", "components", "TrailerModal.tsx")]);
  });

  it("une CSP réduite au cadre de cette fenêtre", async () => {
    const policy = await csp();
    expect(policy["frame-src"]).toBe("frame-src https://www.youtube-nocookie.com");
    for (const directive of ["script-src", "img-src", "connect-src"]) {
      expect(policy[directive], directive).not.toMatch(/youtube/);
    }
  });
});
