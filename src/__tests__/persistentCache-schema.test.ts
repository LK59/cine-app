import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PERSISTED_CACHE_SCHEMA } from "@/lib/persistentCache";

/**
 * Une forme d'hier ne doit jamais faire tomber l'écran d'aujourd'hui.
 *
 * Le catalogue gardé sur l'appareil (`persistentCache.ts`) est affiché **avant** que le serveur
 * ait répondu. Si une route change la forme de sa réponse, l'écran reçoit d'abord l'ancienne forme
 * — une liste devenue objet, un champ renommé — et peut planter avant que la bonne n'arrive. La
 * parade est une version de format : l'ancien cache est ignoré dès qu'elle change.
 *
 * Encore faut-il penser à la changer. Ce test lit les déclarations des réponses gardées et en fait
 * une empreinte ; si elles bougent, il échoue tant qu'on n'a pas **augmenté**
 * `PERSISTED_CACHE_SCHEMA` et ajouté la nouvelle empreinte ci-dessous. Une modification sans effet
 * sur la forme (un commentaire) ne compte pas : les commentaires sont retirés avant l'empreinte.
 *
 * Il lit la source, comme `decisions-partagees.test.ts` : la faute à attraper est un oubli, ce
 * qu'aucune assertion sur un résultat ne verrait.
 */

/** Une entrée par version, jamais réécrite : on ajoute la suivante. */
const FINGERPRINTS: Record<number, string> = {
  1: "602c82816f0ecea7",
};

/** Les déclarations qui décrivent ce qui est gardé, par fichier. */
const DECLARATIONS: [file: string, names: string[]][] = [
  ["src/app/api/cinema/movies/route.ts", ["CinemaMovie", "CinemaMoviesPayload"]],
  ["src/app/api/cinema/series/route.ts", ["CinemaSeries", "CinemaSeriesPayload"]],
  ["src/lib/cinemaPayload.ts", ["HydratedPayload"]],
  ["src/lib/cinemaRails.ts", ["Top10Theme"]],
  ["src/app/api/cinema/next-up/route.ts", ["CinemaNextUpItem", "CinemaNextUpPayload"]],
  ["src/app/api/player/lists/route.ts", ["PlayerListItem", "PlayerListsPayload"]],
  ["src/lib/playerRequests.ts", ["PlayerRequest"]],
  ["src/app/api/player/discover/route.ts", ["DiscoveryItem", "DiscoveryRow", "PlayerDiscoverPayload"]],
  ["src/lib/db.ts", ["WatchlistItem", "WatchlistStatus"]],
];

/** La reprise n'a pas de type déclaré : c'est l'objet construit par la route qui fait foi. */
const RESUME_ROUTE = "src/app/api/jellyfin/resume/route.ts";
const RESUME_FROM = "const items = resumeData.Items.map";
const RESUME_TO = "return NextResponse.json({ items });";

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function declaration(source: string, name: string, file: string): string {
  const match = new RegExp(`export (interface|type) ${name}\\b`).exec(source);
  if (!match) throw new Error(`${name} introuvable dans ${file} — la liste de ce test est à mettre à jour.`);
  const start = match.index;
  const end = match[1] === "interface" ? source.indexOf("\n}", start) + 2 : source.indexOf(";\n", start) + 1;
  return source.slice(start, end);
}

function currentFingerprint(): string {
  const parts: string[] = [];
  for (const [file, names] of DECLARATIONS) {
    const source = readFileSync(file, "utf8");
    for (const name of names) parts.push(withoutComments(declaration(source, name, file)));
  }
  const resume = readFileSync(RESUME_ROUTE, "utf8");
  const from = resume.indexOf(RESUME_FROM);
  const to = resume.indexOf(RESUME_TO, from);
  if (from < 0 || to < 0) throw new Error(`La construction de la reprise a changé de forme dans ${RESUME_ROUTE} — ce test est à mettre à jour.`);
  parts.push(withoutComments(resume.slice(from, to)));
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

describe("la version de format du cache du catalogue", () => {
  it("suit la forme des réponses gardées", () => {
    const now = currentFingerprint();
    expect(
      FINGERPRINTS[PERSISTED_CACHE_SCHEMA],
      `Les types des réponses gardées sur l'appareil ont changé (empreinte ${now}). ` +
        `Augmentez PERSISTED_CACHE_SCHEMA dans src/lib/persistentCache.ts et ajoutez ` +
        `« ${PERSISTED_CACHE_SCHEMA + 1}: "${now}" » à FINGERPRINTS — l'ancien cache sera alors ignoré au lieu d'être affiché.`
    ).toBe(now);
  });

  it("ne réutilise jamais l'empreinte d'une version passée", () => {
    const values = Object.values(FINGERPRINTS);
    expect(new Set(values).size).toBe(values.length);
    // Les versions se suivent, et la courante est la dernière : on ajoute, on ne réécrit pas.
    expect(Math.max(...Object.keys(FINGERPRINTS).map(Number))).toBe(PERSISTED_CACHE_SCHEMA);
  });
});
