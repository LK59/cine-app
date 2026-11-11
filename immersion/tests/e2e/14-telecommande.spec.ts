import { expect, test, type Page } from "@playwright/test";
import { enterWorld, place, state, watchErrors } from "../helpers";

type Playback = { status: string; wantPaused: boolean; position: number; duration: number; seek: { to: number } | null; subtitleIndex: number | null };
type Handle = {
  store: { getState(): { playback: Playback } };
  dispatch(command: { type: "open"; item: { id: string; title: string }; from: number | null } | { type: "stop" }): void;
  emit(intent: string): void;
  closePanel(): void;
};
const playback = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().playback);
const emit = (page: Page, intent: string) => page.evaluate((i) => (window as unknown as { __immersion: Handle }).__immersion.emit(i), intent);

/** Un film d'essai (la mire, 12 s) avec une piste de sous-titres, négocié par une réponse écrite à la main. */
async function fakeFilm(page: Page): Promise<void> {
  await page.route(/\/api\/(?!immersion\/)/, (route) => route.fulfill({ status: 502, body: "" }));
  await page.route("**/api/jellyfin/playback/start", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playSessionId: "seance",
        mediaSourceId: "source",
        manifestUrl: "/api/immersion/mire.webm",
        isDirectPlay: true,
        title: "Film d'essai",
        playbackInfo: { playMethod: "DirectPlay", transcodeReasons: [], video: null, audio: null },
        audioTracks: [],
        subtitleTracks: [{ index: 3, language: "fre", title: null, isDefault: false, isForced: false, isHearingImpaired: false, isExternal: false, url: "/api/jellyfin/stream/subtitle/film?index=3" }],
      }),
    })
  );
  await page.route("**/api/jellyfin/stream/subtitle/**", (route) => route.fulfill({ status: 200, contentType: "text/vtt", body: "WEBVTT\n\n00:00:00.000 --> 00:00:59.000\nBonjour\n" }));
}

/**
 * La télécommande : sans film, cliquer l'écran ouvre le panneau, comme avant ; pendant un film, il pose une barre
 * au bas de l'image — lecture / pause, −10 s, +30 s, la barre (clic, molette), les sous-titres — sans ouvrir le
 * panneau, qui reste à un bouton. Un clic ailleurs ou Échap la retire.
 */
test("la télécommande : clic sur l'écran pendant un film, commandes, sortie", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await fakeFilm(page);
  await enterWorld(page);
  // Devant la télévision du salon, le regard sur elle.
  await place(page, -1.9, -1.5, -Math.PI / 2);

  // Sans film : le panneau, comme avant.
  await emit(page, "select");
  await expect.poll(() => state(page, "mode")).toBe("panel");
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.closePanel());
  await expect.poll(() => state(page, "mode")).toBe("walk");

  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "open", item: { id: "film", title: "Film" }, from: 0 }));
  await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");
  await expect(page.getByTestId("hint-remote")).toBeVisible();

  // Pendant le film : la télécommande, pas le panneau.
  await emit(page, "select");
  await expect.poll(() => state(page, "mode")).toBe("remote");
  const remote = page.getByTestId("remote");
  await expect(remote).toBeVisible();
  await expect(remote).toContainText("Film d'essai");
  await expect(page.getByTestId("panel")).toBeHidden();
  await expect(page.getByTestId("hud")).toBeHidden();

  // Lecture / pause.
  await page.getByTestId("remote-toggle").click();
  await expect.poll(async () => (await playback(page)).status).toBe("paused");
  await page.getByTestId("remote-toggle").click();
  await expect.poll(async () => (await playback(page)).status).toBe("playing");

  // Les sauts : +30 s s'arrête une seconde avant la fin, −10 s au début.
  await expect.poll(async () => (await playback(page)).duration).toBeGreaterThan(10);
  await page.getByTestId("remote-forward").click();
  await expect.poll(async () => (await playback(page)).seek?.to).toBeCloseTo(11, 0);
  await page.getByTestId("remote-back").click();
  await expect.poll(async () => (await playback(page)).seek?.to).toBeLessThan(3);

  // La barre : un clic au milieu va au milieu ; la molette dessus avance de dix secondes.
  const bar = page.getByTestId("remote-bar");
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await playback(page)).seek?.to).toBeCloseTo(6, 0);
  const before = (await playback(page)).position;
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await playback(page)).seek?.to).toBeGreaterThan(before + 5);

  // Les sous-titres.
  await page.getByTestId("remote-subtitles").selectOption("3");
  await expect.poll(async () => (await playback(page)).subtitleIndex).toBe(3);

  // Le panneau complet, à un bouton ; on le referme et la visite reprend.
  await page.getByTestId("remote-panel").click();
  await expect.poll(() => state(page, "mode")).toBe("panel");
  await expect(page.getByTestId("now")).toBeVisible();
  // (Le panneau, posé dans le monde, bouge tant que le regard se tourne vers lui : refermé par l'action.)
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.closePanel());
  await expect.poll(() => state(page, "mode")).toBe("walk");

  // Un clic hors de la barre la retire ; Échap aussi. (La mire a pu finir entre-temps : un film fini, le clic
  // ouvrirait le panneau — on la relance.)
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "open", item: { id: "film", title: "Film" }, from: 0 }));
  await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");
  await emit(page, "select");
  await expect.poll(() => state(page, "mode")).toBe("remote");
  await page.mouse.click(40, 40);
  await expect.poll(() => state(page, "mode")).toBe("walk");
  await emit(page, "select");
  await expect.poll(() => state(page, "mode")).toBe("remote");
  await page.keyboard.press("Escape");
  await expect.poll(() => state(page, "mode")).toBe("walk");
  await expect(remote).toBeHidden();

  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
  expect(errors).toEqual([]);
});

test.describe("au doigt", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  /** Au doigt, la télécommande se pose d'un toucher sur l'écran, se commande au doigt, et s'en va seule. */
  test("un toucher sur l'écran pose la télécommande ; elle s'en va seule", async ({ page }) => {
    test.setTimeout(300_000);
    const errors = watchErrors(page);
    await fakeFilm(page);
    await page.goto("/immersion");
    const enter = page.getByTestId("enter");
    await expect(enter).toBeVisible({ timeout: 240_000 });
    await enter.tap({ force: true });
    await expect.poll(() => state(page, "mode"), { timeout: 90_000 }).toBe("walk");
    await place(page, -1.9, -1.5, -Math.PI / 2);
    await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "open", item: { id: "film", title: "Film" }, from: 0 }));
    await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");

    // Le regard est bien sur l'écran (calculé pendant une lecture), puis un toucher bref à droite : « valider ce que l'on vise ».
    await expect.poll(() => state(page, "aimedScreen")).toBe("salon");
    await page.touchscreen.tap(640, 180);
    await expect.poll(() => state(page, "mode")).toBe("remote");
    await expect(page.getByTestId("touch")).toBeHidden();
    await page.getByTestId("remote-toggle").tap();
    await expect.poll(async () => (await playback(page)).status).toBe("paused");
    // Sans geste, elle s'en va (8 s), et les commandes du tactile reviennent.
    await expect.poll(() => state(page, "mode"), { timeout: 15_000 }).toBe("walk");
    await expect(page.getByTestId("touch")).toBeVisible();

    await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
    expect(errors).toEqual([]);
  });
});
