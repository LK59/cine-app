import { expect, test, type Page } from "@playwright/test";
import { enterWorld, watchErrors } from "../helpers";

interface Movie {
  jellyfinItemId: string;
  title: string;
  runtimeMinutes?: number;
  quality?: { resolution?: string | number | null; dynamicRange?: string | null };
}

type Handle = {
  dispatch(command: { type: "open"; item: { id: string; title: string }; from: number | null } | { type: "stop" } | { type: "toggle" } | { type: "seekBy"; delta: number }): void;
  store: { getState(): { playback: { status: string; method: string | null; error: string | null; position: number; duration: number } } };
};

const playback = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().playback);

/** L'image de la vidéo, lue dans le navigateur : sa taille, son horloge, et un pixel non noir. */
async function picture(page: Page) {
  return page.evaluate(() => {
    const video = (window as unknown as { __immersion: { video(): HTMLVideoElement } }).__immersion.video();
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 9;
    const context = canvas.getContext("2d")!;
    context.drawImage(video, 0, 0, 16, 9);
    // `getImageData` lève si la vidéo vient d'une autre origine sans CORS : c'est la vérification elle-même.
    const pixels = context.getImageData(0, 0, 16, 9).data;
    let light = 0;
    for (let i = 0; i < pixels.length; i += 4) light += pixels[i] + pixels[i + 1] + pixels[i + 2];
    return { width: video.videoWidth, height: video.videoHeight, time: video.currentTime, readyState: video.readyState, light };
  });
}

async function playAndCheck(page: Page, movie: Movie, from: number) {
  await page.evaluate(([m, at]) => void (window as unknown as { __immersion: Handle }).__immersion.dispatch({ type: "open", item: { id: (m as Movie).jellyfinItemId, title: (m as Movie).title }, from: at as number }), [movie, from] as const);
  await expect.poll(async () => (await playback(page)).status, { timeout: 90_000, message: `lecture de « ${movie.title} »` }).toBe("playing");
  const first = await picture(page);
  // L'horloge avance : trois secondes de film, quel que soit le temps que le serveur met à suivre
  // (un transcodage sur une machine occupée peut faire attendre le tampon).
  await expect.poll(async () => (await picture(page)).time, { timeout: 60_000, message: "l'horloge de la vidéo avance" }).toBeGreaterThan(first.time + 3);
  const later = await picture(page);
  expect(later.width).toBeGreaterThan(0);
  expect(later.light).toBeGreaterThan(0);
  return { state: await playback(page), picture: later };
}

/**
 * Un vrai film de la bibliothèque sur la télévision du chalet, avec le compte de test, sur une
 * instance jetable : la négociation, l'image dans la texture, la conversion HDR, et l'arrêt.
 */
test("un film SDR puis un film HDR jouent sur la télévision, et l'arrêt part à chaque sortie", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !/\/api\/(jellyfin\/playback\/(start|stop)|player\/log)$/.test(new URL(request.url()).pathname)) return;
    requests.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() as Record<string, unknown> });
  });

  await enterWorld(page);
  const catalogue = (await (await page.request.get("/api/cinema/movies")).json()) as { items: Movie[] };
  const playable = catalogue.items.filter((m) => m.jellyfinItemId && (m.runtimeMinutes ?? 0) > 60);
  const sdr = playable.find((m) => String(m.quality?.resolution) === "1080" && !m.quality?.dynamicRange);
  const hdr = playable.find((m) => m.quality?.dynamicRange === "HDR") ?? playable.find((m) => m.quality?.dynamicRange === "DV");
  expect(sdr, "un film SDR dans la bibliothèque").toBeTruthy();
  expect(hdr, "un film HDR dans la bibliothèque").toBeTruthy();

  // ── SDR : négociation normale, pas de conversion ──────────────────────────────
  const a = await playAndCheck(page, sdr!, 120);
  console.log(`SDR « ${sdr!.title} » : ${a.state.method}, ${a.picture.width}×${a.picture.height}`);
  const startSdr = requests.find((r) => r.url.endsWith("/playback/start"))!;
  expect(startSdr.body.forceAudioTranscode).toBe(true);
  expect(startSdr.body.lighter).toBeUndefined();
  const logSdr = requests.find((r) => r.url.endsWith("/player/log") && r.body.kind === "start")!;
  expect((logSdr.body.fields as Record<string, unknown>).player).toBe("immersion");
  expect((logSdr.body.fields as Record<string, unknown>).sdr).toBeUndefined();

  // ── Les commandes : pause, reprise, saut — c'est l'état qui commande, la vidéo suit ──
  const cmd = (command: Parameters<Handle["dispatch"]>[0]) => page.evaluate((c) => (window as unknown as { __immersion: Handle }).__immersion.dispatch(c), command);
  await cmd({ type: "toggle" });
  await expect.poll(async () => (await playback(page)).status).toBe("paused");
  expect((await picture(page)).readyState).toBeGreaterThan(1);
  const paused = (await picture(page)).time;
  await cmd({ type: "seekBy", delta: 10 });
  await cmd({ type: "seekBy", delta: 10 });
  await expect.poll(async () => (await picture(page)).time).toBeGreaterThan(paused + 18);
  await cmd({ type: "toggle" });
  await expect.poll(async () => (await playback(page)).status, { timeout: 60_000 }).toBe("playing");

  // ── HDR : le changement de film referme la première séance, et l'image est demandée en SDR ──
  requests.length = 0;
  // Assez loin dans le film pour que Jellyfin retienne la position à l'arrêt (il ignore les 5 premiers pour cent).
  const b = await playAndCheck(page, hdr!, 1500);
  console.log(`HDR « ${hdr!.title} » : ${b.state.method}, ${b.picture.width}×${b.picture.height}`);
  expect(requests.some((r) => r.url.endsWith("/playback/stop")), "arrêt de la première séance").toBe(true);
  const startHdr = requests.filter((r) => r.url.endsWith("/playback/start")).pop()!;
  expect(startHdr.body.lighter).toBe(true);
  const logHdr = requests.filter((r) => r.url.endsWith("/player/log") && r.body.kind === "start").pop()!;
  expect((logHdr.body.fields as Record<string, unknown>).sdr).toBe("serveur");
  expect(b.state.method).toBe("Transcode");
  expect(b.picture.width).toBeLessThanOrEqual(1920);

  // ── Sortie : la page s'en va, l'arrêt part quand même ─────────────────────────
  // Une requête `keepalive` envoyée pendant que la page se ferme échappe à l'observation du
  // navigateur de test : la preuve est côté serveur — Jellyfin n'écrit la position d'un titre qu'à
  // l'arrêt de sa séance. Elle était à zéro pour ce compte, elle vaut maintenant ce qu'on a regardé.
  const leftAt = b.picture.time;
  await page.goto("/login");
  await expect
    .poll(async () => ((await (await page.request.get(`/api/jellyfin/playback-state/${hdr!.jellyfinItemId}`)).json()) as { resumeSeconds: number }).resumeSeconds, { timeout: 30_000, message: "la position est écrite à l'arrêt" })
    .toBeGreaterThan(leftAt - 5);
  expect(errors).toEqual([]);
});
