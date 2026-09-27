import { describe, it, expect } from "vitest";
import { PlayerLifecycle, MAX_REBUILDS, REBUILD_WINDOW_MS, REBUILD_STEP_SECONDS } from "@/lib/playerLifecycle";

// Les décisions d'ouverture et de reconstruction de l'hôte natif, une par une, sans navigateur.
// L'hôte les éprouve aussi de bout en bout (ExperimentalPlayerHost.test.tsx) ; ici, chaque règle
// est nommée et vérifiée seule.

describe("le budget de reconstructions", () => {
  it(`en accorde ${MAX_REBUILDS} d'affilée, puis refuse`, () => {
    const lifecycle = new PlayerLifecycle();
    for (let i = 0; i < MAX_REBUILDS; i++) expect(lifecycle.spendRebuild(1000 + i)).toBe(true);
    expect(lifecycle.spendRebuild(2000)).toBe(false);
  });

  it("se renouvelle quand la lecture a tenu plus longtemps que la fenêtre", () => {
    const lifecycle = new PlayerLifecycle();
    for (let i = 0; i < MAX_REBUILDS; i++) lifecycle.spendRebuild(1000);
    expect(lifecycle.spendRebuild(1000 + REBUILD_WINDOW_MS + 1)).toBe(true);
  });
});

describe("une source perdue", () => {
  it("se reconstruit là où elle était, puis au-delà si le même endroit échoue encore", () => {
    const lifecycle = new PlayerLifecycle();
    expect(lifecycle.sourceLost(100, 0)).toEqual({ kind: "rebuild", at: 100, from: 100, skipped: false, attempt: 1 });
    expect(lifecycle.sourceLost(101, 1)).toEqual({ kind: "rebuild", at: 101 + REBUILD_STEP_SECONDS, from: 101, skipped: true, attempt: 2 });
  });

  it("ailleurs, ce n'est pas le même endroit", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.sourceLost(100, 0);
    expect(lifecycle.sourceLost(400, 1)).toMatchObject({ at: 400, skipped: false });
  });

  it("renonce quand le budget est épuisé", () => {
    const lifecycle = new PlayerLifecycle();
    for (let i = 0; i < MAX_REBUILDS; i++) lifecycle.sourceLost(100 * i, i);
    expect(lifecycle.sourceLost(900, 10)).toEqual({ kind: "giveUp" });
  });
});

describe("une reconstruction", () => {
  it("note la position à rouvrir, qui prime sur tout le reste, jusqu'au pipeline prêt", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.restart(1500, { viewerPausedAt: null, hiddenAt: null });
    expect(lifecycle.openingSeconds(1400, 600, 700)).toBe(1500);
    lifecycle.ready();
    expect(lifecycle.rebuildAt).toBeNull();
    expect(lifecycle.openingSeconds(1400, 600, 700)).toBe(1400);
  });

  it("sans reconstruction : la position connue, puis celle de la séance, puis celle du serveur", () => {
    const lifecycle = new PlayerLifecycle();
    expect(lifecycle.openingSeconds(0, 600, 700)).toBe(600);
    expect(lifecycle.openingSeconds(0, undefined, 700)).toBe(700);
    expect(lifecycle.openingSeconds(0, null, null)).toBe(0);
    // `resumeAt: 0` veut dire « du début » : il ne cède pas la place à la position du serveur.
    expect(lifecycle.openingSeconds(0, 0, 700)).toBe(0);
  });

  it("un saut pendant une reconstruction la fait rouvrir là ; hors reconstruction, rien", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.seekDuringRebuild(900);
    expect(lifecycle.rebuildAt).toBeNull();
    lifecycle.restart(100, { viewerPausedAt: null, hiddenAt: null });
    lifecycle.seekDuringRebuild(900);
    expect(lifecycle.rebuildAt).toBe(900);
  });

  it("garde en pause un film mis en pause par le spectateur, pas par iOS en partant", () => {
    const paused = new PlayerLifecycle();
    paused.restart(100, { viewerPausedAt: 5_000, hiddenAt: null });
    expect(paused.consumeKeepPaused()).toBe(true);
    // Une seule fois : le pipeline suivant, lui, repart.
    expect(paused.consumeKeepPaused()).toBe(false);

    const byIos = new PlayerLifecycle();
    // La pause tombe dans la seconde qui précède le passage en arrière-plan : c'est iOS.
    byIos.restart(100, { viewerPausedAt: 9_500, hiddenAt: 10_000 });
    expect(byIos.consumeKeepPaused()).toBe(false);

    const before = new PlayerLifecycle();
    before.restart(100, { viewerPausedAt: 5_000, hiddenAt: 10_000 });
    expect(before.consumeKeepPaused()).toBe(true);
  });

  // Point 2 (docs/cycle-de-vie-lecteur.md) : seul le retour d'arrière-plan gardait un film fini en
  // pause ; une source perdue ou un nouvel essai réseau sur l'écran de fin le relançaient.
  it("garde en pause toute reconstruction d'un film fini, jusqu'à ce qu'il reprenne", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.noteEnded();
    lifecycle.restart(5400, { viewerPausedAt: null, hiddenAt: null });
    expect(lifecycle.consumeKeepPaused()).toBe(true);
    lifecycle.noteResumedAfterEnd();
    lifecycle.restart(20, { viewerPausedAt: null, hiddenAt: null });
    expect(lifecycle.consumeKeepPaused()).toBe(false);
  });

  it("le retour d'une diffusion arrêtée d'elle-même commence en pause", () => {
    expect(new PlayerLifecycle({ startPaused: true }).consumeKeepPaused()).toBe(true);
    expect(new PlayerLifecycle().consumeKeepPaused()).toBe(false);
  });
});

describe("le retour d'arrière-plan sur une source fermée", () => {
  it("reconstruit là où en était le film", () => {
    const lifecycle = new PlayerLifecycle();
    expect(lifecycle.backgroundLost({ position: 1200, hold: null }, 0)).toBe(1200);
    expect(lifecycle.consumeKeepPaused()).toBe(false);
  });

  it("en pause, un peu avant, quand le retour retient la lecture", () => {
    const lifecycle = new PlayerLifecycle();
    expect(lifecycle.backgroundLost({ position: 1200, hold: { at: 1197 } }, 0)).toBe(1197);
    expect(lifecycle.consumeKeepPaused()).toBe(true);
  });

  it("en pause sur l'écran de fin", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.noteEnded();
    const at = lifecycle.backgroundLost({ position: 5400, hold: null }, 0);
    lifecycle.restart(at!, { viewerPausedAt: null, hiddenAt: null });
    expect(lifecycle.consumeKeepPaused()).toBe(true);
  });

  it("rien quand une reconstruction attend déjà", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.restart(300, { viewerPausedAt: null, hiddenAt: null });
    expect(lifecycle.backgroundLost({ position: 1200, hold: null }, 0)).toBeNull();
  });
});

describe("les nouveaux essais réseau", () => {
  it("s'espacent à chaque échec jusqu'à 30 s, et repartent à zéro dès qu'une image revient", () => {
    const lifecycle = new PlayerLifecycle();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      delays.push(lifecycle.networkRetryDelay());
      lifecycle.noteNetworkRetry();
    }
    expect(delays).toEqual([800, 1600, 3200, 6400, 12800, 25600, 30000, 30000]);
    lifecycle.ready();
    expect(lifecycle.networkRetryDelay()).toBe(800);
  });
});

describe("passer la main", () => {
  it("une seule fois", () => {
    const lifecycle = new PlayerLifecycle();
    expect(lifecycle.hasSteppedAside()).toBe(false);
    expect(lifecycle.stepAside()).toBe(true);
    expect(lifecycle.stepAside()).toBe(false);
    expect(lifecycle.hasSteppedAside()).toBe(true);
  });
});

// Points 4 et 5 (docs/cycle-de-vie-lecteur.md) : après avoir passé la main, ou pendant la
// fermeture, le lecteur ne prend plus d'initiative.
describe("un lecteur qui a fini de décider", () => {
  it("après avoir passé la main : ni reconstruction après une perte, ni au retour d'arrière-plan", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.stepAside();
    expect(lifecycle.isOver()).toBe(true);
    expect(lifecycle.sourceLost(100, 0)).toEqual({ kind: "ignore" });
    expect(lifecycle.backgroundLost({ position: 100, hold: null }, 0)).toBeNull();
  });

  it("pendant la fermeture : ni bascule, ni reconstruction", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.noteClosing();
    expect(lifecycle.stepAside()).toBe(false);
    expect(lifecycle.sourceLost(100, 0)).toEqual({ kind: "ignore" });
    expect(lifecycle.backgroundLost({ position: 100, hold: null }, 0)).toBeNull();
  });

  it("un lecteur ordinaire décide encore", () => {
    const lifecycle = new PlayerLifecycle();
    expect(lifecycle.isOver()).toBe(false);
    expect(lifecycle.sourceLost(100, 0).kind).toBe("rebuild");
  });
});

// Le point de contrôle unique des reconstructions automatiques (relu le 27/09/2026) : un nouvel
// essai réseau armé avant la fermeture relançait le lecteur pendant son fondu.
describe("reconstruire : automatique ou demandé", () => {
  const facts = { viewerPausedAt: null, hiddenAt: null };

  it("une reconstruction automatique est refusée une fois la main passée, ou pendant la fermeture", () => {
    const stepped = new PlayerLifecycle();
    stepped.stepAside();
    expect(stepped.restart(100, facts)).toBe(false);
    expect(stepped.rebuildAt).toBeNull();

    const closing = new PlayerLifecycle();
    closing.noteClosing();
    expect(closing.restart(100, facts)).toBe(false);
  });

  it("une demande du spectateur passe toujours, et redonne la main au lecteur", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.stepAside();
    expect(lifecycle.restart(100, { ...facts, byViewer: true })).toBe(true);
    // Ses pannes suivantes comptent de nouveau : elles ne sont plus ignorées.
    expect(lifecycle.isOver()).toBe(false);
    expect(lifecycle.sourceLost(100, 0).kind).toBe("rebuild");
  });

  it("sauf pendant la fermeture, où rien ne redonne la main", () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.noteClosing();
    lifecycle.restart(100, { ...facts, byViewer: true });
    expect(lifecycle.isOver()).toBe(true);
  });
});
