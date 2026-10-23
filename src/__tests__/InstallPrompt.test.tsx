// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
// `/api/config/public` : la nouvelle adresse annoncée (`passageHost`), ou rien.
const cfg = vi.hoisted(() => ({ data: { passageHost: null as string | null } as { passageHost: string | null } | undefined }));
vi.mock("swr", () => ({ default: () => ({ data: cfg.data, error: undefined }) }));

import { InstallPrompt } from "@/components/InstallPrompt";
import { PassageInstallHelp } from "@/components/passage/PassageInstallHelp";
import { useInstallHintText } from "@/lib/passage/useOldAddress";

beforeEach(() => {
  cfg.data = { passageHost: null };
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  try {
    localStorage.clear();
  } catch {}
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 15/10/2026 (passe de nuit, MOBILE-1 / ROBUSTESSE-9) : dans Safari sur iPhone, la bannière se posait
// exactement sur la barre du bas du cinéma — ses quatre onglets ne répondaient plus — et sa seule
// sortie était une croix de 13 px sans nom.
describe("bannière « Installer »", () => {
  it("se pose au-dessus de la réserve de la barre du bas, avec une croix nommée de 44 px", () => {
    render(<InstallPrompt />);
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    const close = screen.getByRole("button", { name: "common.close" });
    expect(close.className).toContain("h-11");
    expect(close.className).toContain("w-11");
    const frame = close.closest<HTMLElement>(".fixed")!;
    expect(frame.style.paddingBottom).toContain("var(--player-bar-space, 0px)");
  });

  // Relecture du 23/10/2026 (§119) : sur l'ancienne adresse, l'invitation poussait à réinstaller
  // l'adresse qu'on quitte. Les trois cas : ancienne adresse, nouvelle adresse, sans réglage.
  function shown(): boolean {
    const view = render(<InstallPrompt />);
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    const found = document.querySelector("[data-install-prompt]") !== null;
    view.unmount();
    return found;
  }

  it("ne s'affiche pas sur l'ancienne adresse quand une nouvelle est annoncée", () => {
    cfg.data = { passageHost: "app.example.org" };
    expect(shown()).toBe(false);
  });

  it("s'affiche sur la nouvelle adresse elle-même, comme sans réglage", () => {
    cfg.data = { passageHost: window.location.host };
    expect(shown()).toBe(true);
    cfg.data = { passageHost: null };
    expect(shown()).toBe(true);
  });

  it("attend de savoir avant de s'afficher", () => {
    cfg.data = undefined;
    expect(shown()).toBe(false);
  });

  it("l'aide « Ajouter à l'écran d'accueil » du passage et la phrase des notifications suivent la même règle", () => {
    function Hint() {
      return <p data-testid="hint">{useInstallHintText()}</p>;
    }
    cfg.data = { passageHost: "app.example.org" };
    const old = render(<><PassageInstallHelp /><Hint /></>);
    expect(document.querySelector("[data-passage-install]")).toBeNull();
    expect(screen.getByTestId("hint").textContent).toBe("player.onboarding.notifInstallElsewhere");
    old.unmount();
    for (const passageHost of [window.location.host, null]) {
      cfg.data = { passageHost };
      const view = render(<><PassageInstallHelp /><Hint /></>);
      expect(document.querySelector("[data-passage-install]")).not.toBeNull();
      expect(screen.getByTestId("hint").textContent).toBe("player.onboarding.notifInstall");
      view.unmount();
    }
  });

  // La même décision pour l'autre bannière du bas (« Réactiver les notifications ») : une seule
  // valeur, lue par les deux.
  it("est partagée avec la bannière des notifications", () => {
    const src = readFileSync(join(process.cwd(), "src/components/player/PushResumePrompt.tsx"), "utf8");
    expect(src).toContain("paddingBottom: ABOVE_BOTTOM_BAR");
    expect(src).toContain("PROMPT_CLOSE_CLASS");
  });
});

// Après un passage d'adresse (DECISIONS.md §119) : l'aide d'installation aussitôt, en grand, avec les
// trois gestes — et dans la vue intégrée de l'ancienne application aussi, qui se dit « standalone »
// (iPhone du propriétaire, 23/10/2026 : l'invitation aux notifications y avait pris sa place).
describe("l'aide d'installation après un passage", () => {
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
  const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem("cine:passage-install-help", "1");
  });
  const standaloneMedia = () =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("standalone"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  function arrive() {
    const view = render(<InstallPrompt />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    return view;
  }
  const banner = () => document.querySelector('[data-install-prompt="passage"]');

  it("iPhone, onglet : tout de suite, les trois gestes numérotés, et les notifications renvoyées à l'app installée", () => {
    arrive();
    expect(banner()).not.toBeNull();
    const steps = [...banner()!.querySelectorAll("ol > li")].map((li) => li.textContent);
    expect(steps).toEqual(["passage.install.iosAdd", "passage.install.open", "passage.install.removeOld"]);
    expect(banner()!.textContent).toContain("passage.install.notifications");
    expect(banner()!.textContent).not.toContain("passage.install.androidAdd");
  });

  it("iPhone, vue intégrée arrivée par le lien (« standalone ») : affichée aussi", () => {
    standaloneMedia();
    sessionStorage.setItem("cine:passage-link-tab", "1");
    arrive();
    expect(banner()).not.toBeNull();
  });

  it("dans l'application installée (sans lien de passage) : rien", () => {
    standaloneMedia();
    arrive();
    expect(banner()).toBeNull();
  });

  it("Android : le menu du navigateur, sans la ligne des notifications ; ordinateur : rien", () => {
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: ANDROID });
    const view = arrive();
    const steps = [...banner()!.querySelectorAll("ol > li")].map((li) => li.textContent);
    expect(steps[0]).toBe("passage.install.androidAdd");
    expect(banner()!.textContent).not.toContain("passage.install.notifications");
    view.unmount();
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: DESKTOP });
    arrive();
    expect(banner()).toBeNull();
  });

  it("se referme, et ne revient pas dans cet onglet", () => {
    const view = arrive();
    act(() => {
      screen.getByRole("button", { name: "common.close" }).click();
    });
    expect(banner()).toBeNull();
    view.unmount();
    arrive();
    expect(banner()).toBeNull();
  });
});
