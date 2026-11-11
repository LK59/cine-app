import { expect, test, type Page } from "@playwright/test";
import { state, watchErrors } from "../helpers";

/**
 * Ce que le pare-feu du serveur voit d'une visite — le garde-fou du 11/11/2026.
 *
 * CrowdSec bannit pour des heures, et de tout le serveur, une adresse qui :
 * - demande plus de ~40 **noms de fichiers distincts** « non statiques » en rafale (`http-crawl-non_statics` : le
 *   nom seul compte, sans dossier ni requête ; sont statiques les seules extensions de `STATIC` ci-dessous) ;
 * - reçoit une dizaine de 404 / 403 / 400 en dix secondes (`http-probing`).
 * Ouvrir le chalet demandait ≈ 180 fichiers : un iPhone a été banni 4 h. Depuis, les décors arrivent en trois
 * paquets (`src/lib/packs.ts`).
 *
 * Mesuré ici sur un chargement complet puis sur un rechargement à la suite, comme le pare-feu les compterait
 * (même adresse, quelques secondes) : au plus `MAX_NAMES` noms distincts non statiques — la règle en tolère 40,
 * la marge est pour l'application (ses routes `/api` comptent aussi) — et aucune réponse 4xx.
 */
const STATIC = new Set(["jpg", "jpeg", "png", "svg", "gif", "webp", "avif", "bmp", "ico", "css", "js", "mjs", "map", "mp3", "mp4", "wav", "woff", "woff2", "ttf", "otf", "eot", "gz", "brotli", "ts", "tgz", "bvr"]);
const MAX_NAMES = 25;

/** Le nom de fichier tel que l'analyseur de CrowdSec le tire de la requête : le dernier segment du chemin. */
const fileName = (url: string) => decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
const isStatic = (name: string) => STATIC.has(name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

async function load(page: Page, first: boolean): Promise<void> {
  if (first) await page.goto("/immersion");
  else await page.reload();
  const enter = page.getByTestId("enter");
  await expect(enter).toBeVisible({ timeout: 240_000 });
  await enter.click();
  await expect.poll(() => state(page, "phase"), { timeout: 90_000 }).toBe("world");
  // Ce qui part après l'entrée (sons, musique, mesures) compte aussi.
  await page.waitForTimeout(5000);
}

test("un chargement puis un rechargement : peu de noms non statiques, aucune réponse 4xx", async ({ page, context }) => {
  test.setTimeout(600_000);
  const errors = watchErrors(page);
  const names = new Map<string, string>();
  const refused: string[] = [];
  context.on("response", (response) => {
    const url = response.url();
    if (!/^https?:/.test(url)) return;
    const name = fileName(url);
    const status = response.status();
    // Une réponse en erreur compte pour le premier seuil quelle que soit son extension.
    if (!isStatic(name) || status >= 400) names.set(name, `${status} ${new URL(url).pathname}`);
    if (status >= 400 && status < 500) refused.push(`${status} ${new URL(url).pathname}`);
  });

  await load(page, true);
  await load(page, false);

  console.log(`noms distincts non statiques : ${names.size}\n${[...names.values()].sort().join("\n")}`);
  console.log(`réponses 4xx : ${refused.length}${refused.length ? `\n${refused.join("\n")}` : ""}`);
  expect(refused).toEqual([]);
  expect(names.size).toBeLessThanOrEqual(MAX_NAMES);
  // Les décors sont bien venus des paquets : la lumière précalculée est en place.
  expect(await state(page, "baked")).toBe(true);
  expect(errors).toEqual([]);
});
