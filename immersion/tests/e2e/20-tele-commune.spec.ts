import { expect, test, type Browser, type Page } from "@playwright/test";
import { createHash, createHmac } from "node:crypto";
import { enterWorld, watchErrors } from "../helpers";

/**
 * La télévision commune d'un salon et les avatars (DECISIONS.md §146, étapes 3 et 5) : contre un vrai service.
 *
 * - Bob arrive par le **lien d'invitation** d'Alice (`#salon=CODE`).
 * - L'**apparence** qu'Alice choisit arrive chez Bob.
 * - Alice lance un titre : l'application (jouée ici) reçoit la liste des présents signée par le service et rend le
 *   droit signé pour ce salon ; chacun ouvre **son** flux en pause, dit « prêt », et la lecture part ensemble.
 * - Bob met en pause : les deux s'arrêtent au même endroit ; Alice saute : les deux repartent de là.
 * - Un titre que quelqu'un ne peut pas voir ne se lance pas, et on le dit.
 *
 * Le sceau est recopié ici (`salons/src/seal.ts`) : le conteneur des scénarios ne voit que `immersion/`.
 */
const KEY = "cle-de-test-des-salons-scenario-18-0123456789";

type Tv = { itemId: string; phase: string; position: number; epoch: number } | null;
type Member = { id: string; name: string; look?: number[] | null };
type St = { playback: { status: string; itemId: string | null; position: number; wantPaused: boolean }; net: { you: { id: string } | null; error: string | null; room: { code: string; tv: Tv; members: Member[] } | null } };
type Handle = { emit(intent: string): void; dispatch(c: unknown): void; video(): HTMLVideoElement | null; store: { getState(): St } };
const st = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState() as unknown as St);
const videoTime = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.video()?.currentTime ?? -1);
const dispatch = (page: Page, command: unknown) => page.evaluate((c) => (window as unknown as { __immersion: Handle }).__immersion.dispatch(c), command);

function signPass(name: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: `compte-${name}`, name, admin: false, exp: Date.now() + 300_000 })).toString("base64url");
  return `v1.${payload}.${createHmac("sha256", KEY).update(`v1.${payload}`).digest("base64url")}`;
}
function signValue(value: unknown, purpose: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const key = createHash("sha256").update(`laterna-salons:${purpose}:${KEY}`).digest();
  return `v1.${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

async function visitor(browser: Browser, name: string, path = "/immersion") {
  const context = await browser.newContext({ storageState: "/tmp/immersion-state.json" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const asked: { itemId: string; subs: string[] }[] = [];
  const refused = new Set<string>();
  await page.route("**/api/salons/pass", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, pass: signPass(name), socket: "/api/salons/ws" }) }));
  await page.route("**/api/salons/avatar", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(route.request().method() === "PUT" ? { saved: true } : { look: null }) })
  );
  await page.route("**/api/salons/titre", async (route) => {
    const body = route.request().postDataJSON() as { itemId: string; roster: string };
    // La liste signée par le service : on la lit comme l'application (elle vérifie la signature, ici on lui fait foi).
    const roster = JSON.parse(Buffer.from(body.roster.split(".")[1], "base64url").toString("utf8")) as { room: string; subs: string[] };
    asked.push({ itemId: body.itemId, subs: roster.subs });
    const allowed = !refused.has(body.itemId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(allowed ? { allowed: true, ticket: signValue({ room: roster.room, itemId: body.itemId, exp: Date.now() + 300_000 }, "tv") } : { allowed: false }),
    });
  });
  await page.route("**/api/jellyfin/playback/start", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playSessionId: `seance-${name}`,
        mediaSourceId: "source",
        manifestUrl: "/api/immersion/mire.webm",
        isDirectPlay: true,
        title: "La mire",
        introSkip: null,
        recapSkip: null,
        creditsStart: null,
        playbackInfo: { playMethod: "DirectPlay", transcodeReasons: [], video: { codec: "vp9", width: 1280, height: 720, rangeType: "SDR" }, audio: { codec: "opus", channels: 2 } },
        audioTracks: [],
        subtitleTracks: [],
      }),
    })
  );
  await page.route("**/api/player/item/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seriesId: null, download: null }) }));
  await enterWorld(page, path);
  return { context, page, errors, asked, refused };
}

test("télévision commune : lien d'invitation, apparence, départ ensemble, pause et saut partagés, titre refusé", async ({ browser }) => {
  test.setTimeout(420_000);
  const a = await visitor(browser, "Alice");
  await a.page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.emit("menu"));
  await a.page.getByTestId("open-salons").click();
  await a.page.getByTestId("salons-create-private").click();
  const code = (await a.page.getByTestId("salons-code").textContent())!.trim();

  // Bob arrive par le lien : le code quitte l'adresse, et il est dans le salon.
  const b = await visitor(browser, "Bob", `/immersion#salon=${code}`);
  await expect.poll(async () => (await st(b.page)).net.room?.code, { timeout: 20_000 }).toBe(code);
  expect(new URL(b.page.url()).hash).toBe("");
  await expect(a.page.getByTestId("salons-members").locator("li")).toHaveCount(2);

  // Alice choisit son apparence : elle arrive chez Bob.
  await a.page.getByTestId("avatar-color-3").click();
  await a.page.getByTestId("avatar-hat-1").click();
  const aliceId = (await st(a.page)).net.you!.id;
  await expect.poll(async () => (await st(b.page)).net.room!.members.find((m) => m.id === aliceId)?.look, { timeout: 10_000 }).toEqual([3, 1, -1, 0]);
  await a.page.getByTestId("salons-back").click();
  await a.page.getByTestId("resume").click();

  // Alice lance : le droit est demandé pour les deux présents, puis chacun ouvre son flux et la lecture part ensemble.
  await dispatch(a.page, { type: "open", item: { id: "film-commun", title: "La mire" }, from: 1 });
  await expect.poll(() => a.asked.length, { timeout: 10_000 }).toBe(1);
  expect(a.asked[0].subs.sort()).toEqual(["compte-Alice", "compte-Bob"]);
  for (const v of [a, b]) {
    await expect.poll(async () => (await st(v.page)).playback.itemId, { timeout: 30_000 }).toBe("film-commun");
  }
  for (const v of [a, b]) {
    await expect.poll(async () => (await st(v.page)).net.room?.tv?.phase, { timeout: 30_000 }).toBe("playing");
    await expect.poll(async () => (await st(v.page)).playback.status, { timeout: 15_000 }).toBe("playing");
  }
  // Les deux lectures se tiennent (même horloge du service ; le second relevé un peu après le premier).
  await a.page.waitForTimeout(1500);
  const [ta, tb] = await Promise.all([videoTime(a.page), videoTime(b.page)]);
  expect(ta).toBeGreaterThan(1.5);
  expect(Math.abs(ta - tb)).toBeLessThan(0.6);

  // Bob met en pause : les deux s'arrêtent au même endroit.
  await dispatch(b.page, { type: "pause" });
  for (const v of [a, b]) await expect.poll(async () => (await st(v.page)).playback.status, { timeout: 10_000 }).toBe("paused");
  await a.page.waitForTimeout(800);
  const [pa, pb] = await Promise.all([videoTime(a.page), videoTime(b.page)]);
  const paused = (await st(a.page)).net.room!.tv!.position;
  expect(Math.abs(pa - paused)).toBeLessThan(0.6);
  expect(Math.abs(pb - paused)).toBeLessThan(0.6);

  // Alice saute à 6 s et relance : les deux repartent de là, ensemble.
  await dispatch(a.page, { type: "seek", to: 6 });
  await expect.poll(async () => (await st(b.page)).net.room!.tv!.position, { timeout: 10_000 }).toBe(6);
  await dispatch(a.page, { type: "play" });
  for (const v of [a, b]) await expect.poll(async () => (await st(v.page)).playback.status, { timeout: 30_000 }).toBe("playing");
  await a.page.waitForTimeout(1000);
  const [sa, sb] = await Promise.all([videoTime(a.page), videoTime(b.page)]);
  expect(sa).toBeGreaterThan(6);
  expect(Math.abs(sa - sb)).toBeLessThan(0.6);

  // Un titre que quelqu'un ne peut pas voir : rien ne change, et on le dit.
  b.refused.add("film-interdit");
  await dispatch(b.page, { type: "open", item: { id: "film-interdit", title: "Interdit" }, from: 0 });
  await expect.poll(async () => (await st(b.page)).net.error, { timeout: 10_000 }).toBe("title-refused");
  expect((await st(a.page)).net.room!.tv!.itemId).toBe("film-commun");

  // Alice arrête : la télévision s'éteint chez les deux.
  await dispatch(a.page, { type: "stop" });
  for (const v of [a, b]) await expect.poll(async () => (await st(v.page)).playback.status, { timeout: 10_000 }).toBe("idle");

  for (const v of [a, b]) {
    expect(v.errors).toEqual([]);
    await v.context.close();
  }
});
