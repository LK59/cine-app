import { expect, test, type Page } from "@playwright/test";
import { enterWorld, state, watchErrors } from "../helpers";

type Prompt = { kind: "skip"; what: string; end: number } | { kind: "next"; title: string; countdown: number; running: boolean } | { kind: "stillThere"; title: string } | null;
type Playback = { status: string; itemId: string | null; position: number; wantPaused: boolean; next: { itemId: string; title: string; from: number } | null };
type Handle = {
  store: { getState(): { playback: Playback; prompt: Prompt } };
  dispatch(command: { type: "open"; item: { id: string; title: string }; from: number | null } | { type: "stop" }): void;
};
const playback = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().playback);
const prompt = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().prompt);

/**
 * Enchaîner sans quitter le canapé : « Passer l'intro » à la touche Entrée ; au générique de fin, la carte de
 * l'épisode suivant et son décompte, gelé par une pause ; « Regarder le générique » (Retour arrière) l'écarte
 * jusqu'à la fin de l'épisode, où elle revient ; le décompte arrivé à zéro lance l'épisode suivant, à sa position
 * de reprise. Le dernier épisode d'une saison ordinaire n'enchaîne pas sur les spéciaux.
 *
 * L'application est jouée par des réponses écrites à la main (négociation, série de l'épisode, liste des
 * épisodes) : c'est le chemin du mode qui est vérifié. La mire dure 12 s.
 */
test("épisodes : passer l'intro, carte de l'épisode suivant, décompte, enchaînement", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const negotiations: { itemId: string; startTicks?: number }[] = [];
  await page.route(/\/api\/(?!immersion\/)/, (route) => route.fulfill({ status: 502, body: "" }));
  await page.route("**/api/jellyfin/playback/start", async (route) => {
    const body = route.request().postDataJSON() as { itemId: string; startTicks?: number };
    negotiations.push(body);
    const first = body.itemId === "ep1";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playSessionId: `seance-${negotiations.length}`,
        mediaSourceId: "source",
        manifestUrl: "/api/immersion/mire.webm",
        isDirectPlay: true,
        title: first ? "Série d'essai — S01E01 · Premier" : "Série d'essai — S01E02 · Deuxième",
        // Le premier épisode a ses repères ; le second n'en a pas (la dernière seconde tient lieu de générique).
        introSkip: first ? { start: 0, end: 5 } : null,
        recapSkip: null,
        creditsStart: first ? 6 : null,
        playbackInfo: { playMethod: "DirectPlay", transcodeReasons: [], video: { codec: "vp9", width: 1280, height: 720, rangeType: "SDR" }, audio: { codec: "opus", channels: 2 } },
        audioTracks: [],
        subtitleTracks: [],
      }),
    });
  });
  await page.route("**/api/player/item/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seriesId: "serie", download: null }) }));
  const episode = (id: string, season: number, n: number, title: string, resumeTicks = 0) => ({
    jellyfinItemId: id,
    seasonNumber: season,
    episodeNumber: n,
    title,
    overview: null,
    thumbnailUrl: null,
    runtimeMinutes: 1,
    watched: false,
    resumeTicks,
  });
  await page.route("**/api/cinema/series/serie/episodes", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        // Les spéciaux en dernier, comme la route les rend : ils ne suivent jamais le dernier épisode d'une saison.
        seasons: [
          { seasonNumber: 1, episodes: [episode("ep1", 1, 1, "Premier"), episode("ep2", 1, 2, "Deuxième", 30_000_000)] },
          { seasonNumber: 0, episodes: [episode("sp1", 0, 1, "Spécial")] },
        ],
        nextEpisode: { itemId: "ep2" },
      }),
    })
  );

  await enterWorld(page);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "open", item: { id: "ep1", title: "Série d'essai — S01E01" }, from: 0 }));
  await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");

  // L'intro : l'invite paraît, Entrée la passe.
  await expect.poll(async () => (await prompt(page))?.kind).toBe("skip");
  const skip = page.getByTestId("prompt-skip");
  await expect(skip).toBeVisible();
  await expect(skip).toContainText(/Entrée|Enter|Intro|Eingabe/);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await playback(page)).position).toBeGreaterThanOrEqual(5);
  await expect(skip).toBeHidden();

  // L'épisode suivant est connu (la série de l'épisode, puis sa liste) — avec sa position de reprise.
  await expect.poll(async () => (await playback(page)).next, { timeout: 10_000 }).toEqual({ itemId: "ep2", title: "Série d'essai — S01E02 · Deuxième", from: 3 });

  // Au générique (6 s) : la carte et son décompte.
  await expect.poll(async () => (await prompt(page))?.kind, { timeout: 10_000 }).toBe("next");
  await expect(page.getByTestId("prompt-next")).toContainText("S01E02 · Deuxième");

  // En pause, le décompte s'arrête.
  await page.keyboard.press("Space");
  await expect.poll(async () => (await playback(page)).status).toBe("paused");
  const frozen = await prompt(page);
  await page.waitForTimeout(2500);
  expect(await prompt(page)).toEqual({ ...frozen, running: false });
  await page.keyboard.press("Space");
  await expect.poll(async () => (await playback(page)).status).toBe("playing");

  // « Regarder le générique » : la carte s'efface…
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await prompt(page)) === null).toBe(true);
  await expect(page.getByTestId("prompt-next")).toBeHidden();
  // … et revient à la fin de l'épisode, décompte reparti de dix.
  await expect.poll(async () => (await prompt(page))?.kind, { timeout: 15_000 }).toBe("next");
  const back = (await prompt(page)) as { countdown: number };
  expect(back.countdown).toBeGreaterThanOrEqual(9);
  expect(negotiations).toHaveLength(1);

  // Le décompte arrivé à zéro lance l'épisode suivant, à sa position de reprise.
  await expect.poll(() => negotiations.length, { timeout: 20_000 }).toBe(2);
  expect(negotiations[1].itemId).toBe("ep2");
  expect(negotiations[1].startTicks).toBe(30_000_000);
  await expect.poll(async () => (await playback(page)).itemId).toBe("ep2");
  await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");

  // Dernier épisode de la saison : rien à enchaîner (le spécial a sa propre chaîne).
  await page.waitForTimeout(2500);
  expect((await playback(page)).next).toBeNull();
  expect(await prompt(page)).toBeNull();

  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
  expect(await state(page, "mode")).toBe("walk");
  expect(errors).toEqual([]);
});

/**
 * Trois épisodes enchaînés sans un geste : au quatrième décompte, le chalet demande au lieu de continuer ;
 * répondre lance la suite. (Générique dès la première seconde, pour ne pas attendre trois épisodes entiers.)
 */
test("trois enchaînements sans geste : la question, puis la suite à la réponse", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  const opened: string[] = [];
  const ids = ["e1", "e2", "e3", "e4", "e5"];
  await page.route(/\/api\/(?!immersion\/)/, (route) => route.fulfill({ status: 502, body: "" }));
  await page.route("**/api/jellyfin/playback/start", async (route) => {
    const { itemId } = route.request().postDataJSON() as { itemId: string };
    opened.push(itemId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playSessionId: `seance-${opened.length}`,
        mediaSourceId: "source",
        manifestUrl: "/api/immersion/mire.webm",
        isDirectPlay: true,
        title: `Série — S01E0${ids.indexOf(itemId) + 1} · ${itemId}`,
        introSkip: null,
        recapSkip: null,
        creditsStart: 0,
        playbackInfo: { playMethod: "DirectPlay", transcodeReasons: [], video: null, audio: null },
      }),
    });
  });
  await page.route("**/api/player/item/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seriesId: "serie", download: null }) }));
  await page.route("**/api/cinema/series/serie/episodes", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        seasons: [{ seasonNumber: 1, episodes: ids.map((id, i) => ({ jellyfinItemId: id, seasonNumber: 1, episodeNumber: i + 1, title: id, overview: null, thumbnailUrl: null, runtimeMinutes: 1, watched: false, resumeTicks: 0 })) }],
        nextEpisode: null,
      }),
    })
  );

  await enterWorld(page);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "open", item: { id: "e1", title: "Série" }, from: 0 }));
  // e1 → e2 → e3 → e4 tout seuls.
  await expect.poll(() => opened.join(","), { timeout: 90_000 }).toBe("e1,e2,e3,e4");
  // Le quatrième décompte s'achève sur la question, et rien ne part.
  await expect.poll(async () => (await prompt(page))?.kind, { timeout: 30_000 }).toBe("stillThere");
  await expect(page.getByTestId("prompt-still")).toBeVisible();
  await page.waitForTimeout(2000);
  expect(opened).toHaveLength(4);
  // Répondre lance la suite.
  await page.keyboard.press("Enter");
  await expect.poll(() => opened.join(","), { timeout: 15_000 }).toBe("e1,e2,e3,e4,e5");

  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
  expect(errors).toEqual([]);
});
