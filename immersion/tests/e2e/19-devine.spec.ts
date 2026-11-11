import { expect, test, type Browser, type Page } from "@playwright/test";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { enterWorld, watchErrors } from "../helpers";

/**
 * « Devine le film » (DECISIONS.md §146) : seul (le moteur tourne dans la page) et dans un salon (le service le fait
 * tourner pour tous). L'application est jouée par des réponses écrites à la main — la partie préparée, le bilan
 * reçu ; dans un salon, les réponses sont scellées ici comme l'application les scelle (`salons/src/seal.ts`, recopié :
 * le conteneur des scénarios ne voit que `immersion/`), et seul le vrai service sait les ouvrir.
 */
const KEY = "cle-de-test-des-salons-scenario-18-0123456789";

type Quiz = { mode: string; choice: number | null; view: { phase: string; round: number; total: number; answer: number | null; players: { name: string; score: number }[] } } | null;
type Handle = { emit(intent: string): void; openPanel(screen?: string): void; store: { getState(): { quiz: Quiz; net: { room: unknown } } } };
const quiz = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().quiz);

const round = (n: number) => ({ kind: "tagline", text: `L'accroche numéro ${n}`, year: 2000 + n, choices: [`Film A${n}`, `Film B${n}`, `Film C${n}`, `Film D${n}`] });
const GAME = { id: "q-scenario-19-solo", variant: "mixte", rounds: [round(1), round(2), round(3)] };
const ANSWERS = [1, 3, 0];

function signPass(name: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: `compte-${name}`, name, admin: false, exp: Date.now() + 300_000 })).toString("base64url");
  return `v1.${payload}.${createHmac("sha256", KEY).update(`v1.${payload}`).digest("base64url")}`;
}
function seal(gameId: string, answers: number[]): string {
  const key = createHash("sha256").update(`laterna-salons:answers:${KEY}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ gameId, answers, exp: Date.now() + 3_600_000 }), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** Répond à chaque manche avec la bonne proposition (touches 1 à 4), jusqu'à la fin. */
async function playAll(page: Page, answers: number[]) {
  for (let r = 0; r < answers.length; r++) {
    await expect.poll(async () => {
      const q = await quiz(page);
      return q && q.view.phase === "question" && q.view.round === r;
    }, { timeout: 30_000 }).toBe(true);
    await page.keyboard.press(String(answers[r] + 1));
    await expect.poll(async () => (await quiz(page))?.choice, { timeout: 5_000 }).toBe(answers[r]);
  }
  await expect.poll(async () => (await quiz(page))?.view.phase, { timeout: 30_000 }).toBe("end");
}

test("seul : la partie sur la télévision, les touches 1 à 4, la révélation, le bilan rendu à l'application", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const results: Record<string, unknown>[] = [];
  await page.route("**/api/quiz/partie", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, game: GAME, answers: ANSWERS }) }));
  await page.route("**/api/quiz/resultat", async (route) => {
    results.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recorded: 1 }) });
  });
  await enterWorld(page);
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.openPanel("salon"));
  // Le panneau 3D bouge tant que le regard se tourne vers lui : le clic est envoyé tel quel.
  await page.getByTestId("quiz-start-mixte").dispatchEvent("click");
  // Le panneau se referme : la télévision montre le jeu, on est de retour dans le chalet.
  await expect.poll(async () => (await quiz(page))?.mode).toBe("solo");
  await expect(page.getByTestId("panel")).toBeHidden();
  await expect(page.getByTestId("quiz-hud")).toBeVisible();

  // Première manche : une mauvaise réponse — puis la bonne réponse révélée.
  await expect.poll(async () => (await quiz(page))?.view.phase, { timeout: 15_000 }).toBe("question");
  await expect(page.getByTestId("quiz-choice-1")).toContainText("Film A1");
  await page.keyboard.press("3");
  await expect.poll(async () => (await quiz(page))?.view.phase, { timeout: 5_000 }).toBe("reveal");
  expect((await quiz(page))?.view.answer).toBe(1);
  await expect(page.getByTestId("quiz-status")).toContainText("Film B1");
  // Les deux suivantes : justes.
  for (const r of [1, 2]) {
    await expect.poll(async () => {
      const q = await quiz(page);
      return q && q.view.phase === "question" && q.view.round === r;
    }, { timeout: 30_000 }).toBe(true);
    await page.keyboard.press(String(ANSWERS[r] + 1));
  }
  await expect.poll(async () => (await quiz(page))?.view.phase, { timeout: 30_000 }).toBe("end");
  await expect(page.getByTestId("quiz-end")).toBeVisible();
  // Le bilan : les réponses données, que l'application recompte (pas un score annoncé).
  await expect.poll(() => results.length, { timeout: 10_000 }).toBe(1);
  expect(results[0].gameId).toBe(GAME.id);
  expect((results[0].picks as { choice: number }[]).map((p) => p.choice)).toEqual([2, 3, 0]);
  expect(results[0]).not.toHaveProperty("score");
  await page.getByTestId("quiz-close").dispatchEvent("pointerdown");
  await expect.poll(() => quiz(page)).toBeNull();
  expect(errors).toEqual([]);
});

async function visitor(browser: Browser, name: string) {
  const context = await browser.newContext({ storageState: "/tmp/immersion-state.json" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const results: Record<string, unknown>[] = [];
  await page.route("**/api/salons/pass", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, pass: signPass(name), socket: "/api/salons/ws" }) }));
  await page.route("**/api/quiz/partie", async (route) => {
    // L'application reçoit la liste signée par le service ; ici, la partie scellée pour lui.
    expect(route.request().postDataJSON().roster).toMatch(/^v1\./);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, game: { ...GAME, id: "q-scenario-19-salon" }, sealed: seal("q-scenario-19-salon", ANSWERS) }) });
  });
  await page.route("**/api/quiz/resultat", async (route) => {
    results.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recorded: 1 }) });
  });
  await enterWorld(page);
  return { context, page, errors, results };
}

test("dans un salon : la même partie chez les deux, le service compte, chacun rend le bilan signé", async ({ browser }) => {
  test.setTimeout(400_000);
  const a = await visitor(browser, "Alice");
  const b = await visitor(browser, "Bob");
  await a.page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.emit("menu"));
  await a.page.getByTestId("open-salons").click();
  await a.page.getByTestId("salons-create-private").click();
  const code = (await a.page.getByTestId("salons-code").textContent())!.trim();
  await b.page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.emit("menu"));
  await b.page.getByTestId("open-salons").click();
  await b.page.getByTestId("salons-code-input").fill(code);
  await b.page.getByTestId("salons-join").click();
  await expect(b.page.getByTestId("salons-members").locator("li")).toHaveCount(2);
  for (const v of [a, b]) {
    await v.page.getByTestId("salons-back").click();
    await v.page.getByTestId("resume").click();
  }

  // Alice lance depuis le panneau ; la partie arrive chez Bob par le service.
  await a.page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.openPanel("salon"));
  await a.page.getByTestId("quiz-start-rapide").dispatchEvent("click");
  await expect.poll(async () => (await quiz(b.page))?.mode, { timeout: 15_000 }).toBe("salon");
  await expect.poll(async () => (await quiz(a.page))?.view.players.length).toBe(2);

  // Alice répond juste et vite, Bob se trompe à chaque fois.
  const wrong = ANSWERS.map((x) => (x + 1) % 4);
  await Promise.all([playAll(a.page, ANSWERS), playAll(b.page, wrong)]);
  const end = (await quiz(a.page))!;
  expect(end.view.players[0].name).toBe("Alice");
  expect(end.view.players[0].score).toBeGreaterThan(3000);
  expect(end.view.players.find((p) => p.name === "Bob")!.score).toBe(0);
  // Chacun rend le bilan signé par le service (l'application ne l'enregistre qu'une fois par compte).
  for (const v of [a, b]) {
    await expect.poll(() => v.results.length, { timeout: 10_000 }).toBe(1);
    expect(v.results[0].result).toMatch(/^v1\./);
  }
  for (const v of [a, b]) {
    expect(v.errors).toEqual([]);
    await v.context.close();
  }
});
