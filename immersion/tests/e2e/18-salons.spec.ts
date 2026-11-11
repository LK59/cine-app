import { expect, test, type Browser, type Page } from "@playwright/test";
import { enterWorld, watchErrors } from "../helpers";
import { createHmac } from "node:crypto";

/**
 * Le laissez-passer, signé comme l'application le signe (`src/lib/salons/pass.ts`). Recopié ici parce que le
 * conteneur des scénarios ne voit que `immersion/` ; le format est gardé ailleurs par le vecteur partagé entre
 * l'application et le service — et ce scénario ne passe que si le vrai service l'accepte.
 */
function signPass(claims: { sub: string; name: string; admin: boolean; exp: number }, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `v1.${payload}.${createHmac("sha256", key).update(`v1.${payload}`).digest("base64url")}`;
}

/**
 * Les salons du chalet (DECISIONS.md §146), avec un vrai service `laterna-salons` derrière l'aperçu (lancé à part
 * avec la clé ci-dessous, `SALONS_DEV_URL`) : le laissez-passer est celui que l'application délivrerait, signé ici.
 *
 * Deux navigateurs : l'un crée un salon privé, l'autre le rejoint par son code ; chacun voit l'autre ; une coupure
 * rend la même place ; un salon public se trouve dans la liste ; un code inconnu le dit ; et sans service pour la
 * session, l'écran dit que le chalet reste solitaire.
 */
const KEY = "cle-de-test-des-salons-scenario-18-0123456789";

type Handle = { emit(intent: string): void; store: { getState(): { setMode(m: string): void; net: { status: string; you: { id: string } | null; room: { code: string; members: { name: string; away: boolean }[] } | null } } }; salons: { drop(): void } };
const net = (page: Page) => page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.store.getState().net);

async function visitor(browser: Browser, name: string, available = true) {
  const context = await browser.newContext({ storageState: "/tmp/immersion-state.json" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.route("**/api/salons/pass", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(available ? { available: true, pass: signPass({ sub: `compte-${name}`, name, admin: false, exp: Date.now() + 300_000 }, KEY), socket: "/api/salons/ws" } : { available: false }),
    })
  );
  await enterWorld(page);
  return { context, page, errors };
}

/** Le menu par l'intention « menu », comme Échap : elle rend le pointeur — verrouillé, il garderait tous les clics. */
async function openSalons(page: Page) {
  await page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.emit("menu"));
  await page.getByTestId("open-salons").click();
}

test("deux navigateurs dans un salon privé puis public ; une coupure garde la place ; sans service, seul", async ({ browser }) => {
  test.setTimeout(600_000);
  const a = await visitor(browser, "Alice");
  const b = await visitor(browser, "Bob");

  // Alice crée un salon privé ; son code d'invitation s'affiche.
  await openSalons(a.page);
  await a.page.getByTestId("salons-create-private").click();
  const code = (await a.page.getByTestId("salons-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);

  // Bob : un code inconnu d'abord, puis le bon.
  await openSalons(b.page);
  await expect(b.page.getByTestId("salons-lobby")).toBeVisible();
  await b.page.getByTestId("salons-code-input").fill("ZZZZZZ");
  await b.page.getByTestId("salons-join").click();
  await expect(b.page.getByTestId("salons-error")).toBeVisible();
  await b.page.getByTestId("salons-code-input").fill(code.toLowerCase());
  await b.page.getByTestId("salons-join").click();
  await expect(b.page.getByTestId("salons-members").locator("li")).toHaveCount(2);
  await expect(a.page.getByTestId("salons-members").locator("li")).toHaveCount(2);
  await expect(a.page.getByTestId("salons-members")).toContainText("Bob");

  // Une coupure chez Bob : absent chez Alice, puis de retour à la même place, dans le même salon.
  const before = (await net(b.page)).you!.id;
  await b.page.evaluate(() => (window as unknown as { __immersion: Handle }).__immersion.salons.drop());
  await expect.poll(async () => (await net(a.page)).room?.members.find((m) => m.name === "Bob")?.away, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await net(b.page)).status, { timeout: 15_000 }).toBe("online");
  expect((await net(b.page)).you!.id).toBe(before);
  expect((await net(b.page)).room?.code).toBe(code);
  await expect.poll(async () => (await net(a.page)).room?.members.find((m) => m.name === "Bob")?.away, { timeout: 10_000 }).toBe(false);

  // Bob s'en va : Alice est seule.
  await b.page.getByTestId("salons-leave").click();
  await expect(a.page.getByTestId("salons-members").locator("li")).toHaveCount(1);

  // Un salon public : Alice en ouvre un, Bob le trouve dans la liste et y entre.
  await a.page.getByTestId("salons-leave").click();
  await a.page.getByTestId("salons-create-public").click();
  await expect(a.page.getByTestId("salons-room")).toBeVisible();
  await b.page.getByText(/Actualiser|Refresh|Actualizar|Aktualisieren/).click();
  await b.page.getByTestId("salons-public").getByRole("button").first().click();
  await expect(b.page.getByTestId("salons-members").locator("li")).toHaveCount(2);

  // Jouer seul : la connexion se ferme ; Alice le voit partir.
  await b.page.getByTestId("salons-leave").click();
  await b.page.getByTestId("salons-solo").click();
  await expect.poll(async () => (await net(b.page)).status).toBe("off");
  await expect(a.page.getByTestId("salons-members").locator("li")).toHaveCount(1);

  // Sans service pour cette session : le chalet reste solitaire, et l'écran le dit.
  const c = await visitor(browser, "Chloé", false);
  await openSalons(c.page);
  await expect(c.page.getByTestId("salons-unavailable")).toBeVisible();

  for (const v of [a, b, c]) {
    expect(v.errors).toEqual([]);
    await v.context.close();
  }
});
