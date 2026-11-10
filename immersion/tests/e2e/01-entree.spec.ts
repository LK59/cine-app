import { expect, test } from "@playwright/test";
import { watchErrors } from "../helpers";

/** L'accueil du compte de test se propose à chaque session neuve : « Passer », comme un spectateur. */
async function openCinema(page: import("@playwright/test").Page) {
  await page.addInitScript(() => sessionStorage.setItem("cine:onboarding-skipped", String(Date.now())));
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
}

async function openSearch(page: import("@playwright/test").Page) {
  await page.goto("/#panel=search");
  const input = page.locator('input[type="search"]').first();
  if (!(await input.isVisible().catch(() => false))) {
    // L'adresse du panneau peut changer : à défaut, le bouton de recherche du rail.
    await page.goto("/");
    await page.getByRole("button", { name: /recherche|search/i }).first().click();
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
    await card.click();
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
