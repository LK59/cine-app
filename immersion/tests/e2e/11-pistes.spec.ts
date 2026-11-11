import { expect, test, type Page } from "@playwright/test";
import { enterWorld, state, watchErrors } from "../helpers";

type Playback = { status: string; audioTracks: { index: number }[]; subtitleTracks: { index: number }[]; audioIndex: number | null; subtitleIndex: number | null; position: number };
type Handle = {
  store: { getState(): { playback: Playback } };
  dispatch(command: { type: "open"; item: { id: string; title: string }; from: number | null } | { type: "stop" }): void;
  openPanel(screen?: string): void;
  video(): HTMLVideoElement;
  cueAt(time: number): string;
};
const playback = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().playback);

/**
 * Les pistes : le panneau propose les pistes audio et les sous-titres du film ; changer de piste audio
 * renégocie le flux avec cette piste, à la position où l'on est ; les sous-titres choisis sont lus et la
 * réplique du moment est celle qui se dessine sur les écrans. L'application est jouée ici par des réponses
 * écrites à la main (la négociation, la piste en WebVTT) : c'est le chemin du mode qui est vérifié.
 */
test("pistes audio et sous-titres : choix dans le panneau, flux renégocié, réplique du moment", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const negotiations: { audioStreamIndex?: number; startTicks?: number }[] = [];
  // Tout ce que le mode demande d'autre à l'application (bibliothèque, progression, journal) reste sans réponse,
  // comme quand elle est absente : rien de cela n'est nécessaire à la lecture.
  await page.route(/\/api\/(?!immersion\/)/, (route) => route.fulfill({ status: 502, body: "" }));
  await page.route("**/api/jellyfin/playback/start", async (route) => {
    negotiations.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playSessionId: `seance-${negotiations.length}`,
        mediaSourceId: "source",
        manifestUrl: "/api/immersion/mire.webm",
        isDirectPlay: true,
        title: "Film d'essai",
        playbackInfo: { playMethod: "DirectPlay", transcodeReasons: [], video: { codec: "vp9", width: 1280, height: 720, rangeType: "SDR" }, audio: { codec: "opus", channels: 2 } },
        audioTracks: [
          { index: 1, language: "fre", title: null, codec: "ac3", channels: 6, profile: null, isDefault: true },
          { index: 2, language: "eng", title: null, codec: "dts", channels: 6, profile: null, isDefault: false },
        ],
        subtitleTracks: [
          { index: 3, language: "fre", title: null, isDefault: false, isForced: false, isHearingImpaired: false, isExternal: false, url: "/api/jellyfin/stream/subtitle/film?mediaSourceId=source&index=3" },
          { index: 4, language: "eng", title: null, isDefault: false, isForced: true, isHearingImpaired: false, isExternal: false, url: "/api/jellyfin/stream/subtitle/film?mediaSourceId=source&index=4" },
        ],
      }),
    });
  });
  await page.route("**/api/jellyfin/stream/subtitle/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/vtt",
      // La piste 4 ne se lit pas en texte (comme une piste en images) : une réponse vide.
      body: route.request().url().includes("index=3") ? "WEBVTT\n\n1\n00:00:00.000 --> 00:00:59.000\n<i>Bonjour</i> le chalet\nseconde ligne\n\n2\n00:01:00.000 --> 00:01:02.000\nPlus tard\n" : "WEBVTT\n",
    })
  );

  await enterWorld(page);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "open", item: { id: "film", title: "Film" }, from: 0 }));
  await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");
  expect((await playback(page)).audioTracks.map((t) => t.index)).toEqual([1, 2]);
  expect(negotiations).toHaveLength(1);
  expect(negotiations[0].audioStreamIndex).toBeUndefined();

  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.openPanel("salon"));
  const audio = page.getByTestId("now-audio");
  await expect(audio).toBeVisible();
  // Les noms sont ceux du lecteur de l'application : la langue, puis les canaux.
  await expect(audio.locator("option")).toHaveText([/(Français|French).*5\.1/, /(Anglais|English).*5\.1/]);

  // Les sous-titres : la piste texte se lit, sa réplique est celle du moment (balises retirées).
  const subtitles = page.getByTestId("now-subtitles");
  await subtitles.selectOption("3");
  await expect.poll(async () => (await playback(page)).subtitleIndex).toBe(3);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.cueAt(5))).toBe("Bonjour le chalet\nseconde ligne");
  expect(await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.cueAt(59.5))).toBe("");
  expect(await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.cueAt(61))).toBe("Plus tard");

  // Une autre piste audio : le flux est redemandé avec elle, à la position où l'on était, sous-titres gardés.
  await page.waitForTimeout(2500);
  await audio.selectOption("2");
  await expect.poll(() => negotiations.length, { timeout: 15_000 }).toBe(2);
  expect(negotiations[1].audioStreamIndex).toBe(2);
  expect(negotiations[1].startTicks ?? 0).toBeGreaterThan(10_000_000);
  await expect.poll(async () => (await playback(page)).status, { timeout: 30_000 }).toBe("playing");
  expect((await playback(page)).audioIndex).toBe(2);
  await expect.poll(async () => (await playback(page)).subtitleIndex).toBe(3);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.cueAt(5))).toBe("Bonjour le chalet\nseconde ligne");

  // Une piste qui ne se lit pas en texte : le choix retombe sur « aucun ».
  await subtitles.selectOption("4");
  await expect.poll(async () => (await playback(page)).subtitleIndex, { timeout: 10_000 }).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.cueAt(5))).toBe("");

  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "stop" }));
  expect(await state(page, "mode")).toBe("panel");
  expect(errors).toEqual([]);
});
