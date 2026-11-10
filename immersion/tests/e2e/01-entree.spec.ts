import { expect, test } from "@playwright/test";
import { watchErrors } from "../helpers";

/** L'accueil du compte de test se propose à chaque session neuve : « Passer », comme un spectateur. */
async function openCinema(page: import("@playwright/test").Page) {
  await page.addInitScript(() => sessionStorage.setItem("cine:onboarding-skipped", String(Date.now())));
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
}

/**
 * Sur l'instance jetable, la page « CineApp devient Laterna » peut recouvrir le cinéma : elle s'affiche
 * à toute adresse qui n'est pas la nouvelle, et `localhost` n'est pas la nouvelle. Elle n'a rien à voir
 * avec ce qui est vérifié ici ; les clics partent donc de l'élément lui-même, pas du pixel qu'elle couvre.
 */
const press = (target: import("@playwright/test").Locator) => target.evaluate((el) => (el as HTMLElement).click());

async function openSearch(page: import("@playwright/test").Page) {
  // L'adresse du panneau de recherche (`cinemaRoute.ts`).
  await page.goto("/#recherche=1");
  const input = page.locator('input[type="search"]').first();
  const shown = await input.waitFor({ state: "visible", timeout: 8000 }).then(
    () => true,
    () => false
  );
  if (!shown) {
    // À défaut, le bouton de recherche du rail.
    await press(page.getByRole("button", { name: /recherche|search/i }).first());
  }
  await expect(input).toBeVisible();
  return input;
}

test.describe("l'entrée par la recherche", () => {
  test("« immersion » fait apparaître l'affiche du Chalet, qui mène au mode", async ({ page }) => {
    await openCinema(page);
    const input = await openSearch(page);
    await input.fill("immersion");
    const card = page.getByRole("button", { name: /Le Chalet/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Laterna Experience");
    await press(card);
    await page.waitForURL(/\/immersion$/);
    await expect(page.getByRole("img", { name: "Laterna Experience" }).first()).toBeVisible();
  });

  test("une recherche ordinaire n'a pas changé", async ({ page }) => {
    const errors = watchErrors(page);
    await openCinema(page);
    const input = await openSearch(page);
    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q=matrix") && r.ok());
    await input.fill("matrix");
    await answered;
    await expect(page.getByRole("button", { name: /Matrix/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Le Chalet/ })).toHaveCount(0);
    // Le mot inachevé ou prolongé n'est pas le mot.
    await input.fill("immersio");
    await page.waitForTimeout(600);
    await expect(page.getByRole("button", { name: /Le Chalet/ })).toHaveCount(0);
    await input.fill("immersion totale");
    await page.waitForTimeout(600);
    await expect(page.getByRole("button", { name: /Le Chalet/ })).toHaveCount(0);
    expect(page.url()).not.toContain("/immersion");
    expect(errors).toEqual([]);
  });
});

test.describe("la page", () => {
  test("sans session, elle renvoie à la connexion et ses fichiers répondent 401", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto("/immersion");
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get("next")).toBe("/immersion");
    const res = await ctx.request.get("/api/immersion/poster.jpg");
    expect(res.status()).toBe(401);
    await ctx.close();
  });

  test("sur un appareil tactile, elle dit que l'expérience est sur ordinateur", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: "/tmp/immersion-state.json", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto("/immersion");
    await expect(page.getByText(/Expérience disponible sur ordinateur|Experience available on a computer/)).toBeVisible();
    await page.getByTestId("back").click();
    await page.waitForURL((url) => url.pathname === "/");
    await ctx.close();
  });
});
