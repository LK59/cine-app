// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_QUIET_MS, noteUiMotion, uiBusy, uiQuietForTests, watchUiActivity, whenUiQuiet } from "@/lib/uiQuiet";

// Le travail d'arrière-plan qui tient le fil principal (l'enregistrement des ouvertures sur l'appareil)
// attend que personne ne touche l'écran : un appui sur une affiche tombait en plein milieu, et
// l'ouverture de la fiche démarrait derrière (mesuré le 10/10/2026, Chromium, iPhone 13, ×4).

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  uiQuietForTests.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("l'interface au repos", () => {
  it("est au repos tant que rien ne s'est passé", async () => {
    expect(uiBusy()).toBe(false);
    let done = false;
    void whenUiQuiet().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it("un appui la rend occupée, et le travail attend la fin du geste", async () => {
    watchUiActivity();
    window.dispatchEvent(new Event("pointerdown"));
    expect(uiBusy()).toBe(true);
    let done = false;
    void whenUiQuiet().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(UI_QUIET_MS - 100);
    expect(done).toBe(false);
    // Un nouveau geste repousse l'attente.
    window.dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(UI_QUIET_MS - 100);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it("un défilement de rangée compte aussi (il ne remonte pas jusqu'à la page)", () => {
    watchUiActivity();
    const row = document.createElement("div");
    document.body.appendChild(row);
    row.dispatchEvent(new Event("scroll"));
    expect(uiBusy()).toBe(true);
    row.remove();
  });

  it("une animation déclarée tient l'interface occupée pendant sa durée", async () => {
    noteUiMotion(3000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(uiBusy()).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(uiBusy()).toBe(false);
  });

  it("une attente annulée se résout tout de suite : l'appelant décide de s'arrêter", async () => {
    uiQuietForTests.touch();
    const control = new AbortController();
    let done = false;
    void whenUiQuiet(control.signal).then(() => (done = true));
    control.abort();
    await vi.advanceTimersByTimeAsync(30);
    expect(done).toBe(true);
  });
});
