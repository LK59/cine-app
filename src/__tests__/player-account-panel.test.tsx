// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

let payload: Record<string, unknown> = { username: "louis", jfUser: null };
vi.mock("swr", () => ({ default: () => ({ data: payload }) }));
// Le module réel, dont on ne remplace que le `fetcher` : il porte aussi les clés de cache
// (`MOVIES_CATALOGUE_KEY`…) et les options que ces écrans lisent. Un mock qui n'expose que ce
// dont on se souvient les laisse valoir `undefined`.
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async () => payload,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
// `next/link` rendu comme il l'est vraiment — un `<a>` — mais marqué, parce que c'est justement
// ce que le DOM seul ne distingue pas : un `<a>` nu et un `Link` produisent la même balise et
// n'ont pas du tout le même effet sur la page.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} data-client-nav="1" {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr", setLocale: vi.fn() }),
}));
const errorToast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ error: errorToast, success: vi.fn() }) }));
vi.mock("@/components/PushToggle", () => ({ PushToggle: () => <div /> }));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { PlayerAccountPanel, sessionSeenLabel } from "@/components/player/PlayerAccountPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Rend l'agent utilisateur de jsdom après `asBrowser`.
  vi.restoreAllMocks();
});

// 15/10/2026 (passe de nuit, BUREAU-27) : treize lignes « Vue le 14 oct. », impossibles à distinguer.
describe("appareils connectés — vue quand", () => {
  const tr = (k: string, v?: Record<string, string | number>) => (v ? `${k}:${JSON.stringify(v)}` : k);
  it("dit le temps écoulé pour les deux derniers jours, la date au-delà", () => {
    const now = Date.now();
    expect(sessionSeenLabel(now - 5 * 60_000, now, tr, "fr")).toBe('player.account.sessionSeenAgo:{"when":"common.time.minutesAgo:{\\"n\\":5}"}');
    expect(sessionSeenLabel(now - 5 * 24 * 3600_000, now, tr, "fr")).toMatch(/^player\.account\.sessionSeen:/);
  });
});

// La suite (DECISIONS.md §99) : « Cet appareil » en tête, distinct des lignes que le bouton ferme.
describe("appareils connectés — cet appareil", () => {
  it("marque la session de l'appelant en tête, et ne la compte pas parmi les autres", async () => {
    payload = { username: "sarah", jfUser: "sarah", role: "user" };
    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/auth/sessions")) {
          return new Response(
            JSON.stringify({
              count: 1,
              sessions: [{ id: "0", createdAt: now - 86_400_000, lastSeenAt: now - 60_000, device: "Linux · Chrome" }],
              current: { id: "current", createdAt: now - 3_600_000, lastSeenAt: now, device: "iPhone · Safari" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    try {
      const { container } = render(<PlayerAccountPanel />);
      const mine = await waitFor(() => {
        const el = container.querySelector("[data-current-session]");
        if (!el) throw new Error("pas encore");
        return el as HTMLElement;
      });
      expect(mine.textContent).toContain("iPhone · Safari");
      expect(mine.textContent).toContain("player.account.currentDevice");
      const rows = Array.from(mine.parentElement!.children);
      expect(rows[0]).toBe(mine);
      expect(rows).toHaveLength(2);
      expect(rows[1].textContent).toContain("Linux · Chrome");
      expect(rows[1].textContent).not.toContain("player.account.currentDevice");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const FIREFOX_LINUX ="Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0";
const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0";
function asBrowser(userAgent: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

describe("PlayerAccountPanel — known issues", () => {
  // La fiche ne sert qu'à Firefox sous Linux : c'est là seulement que le HDR sort délavé, faute
  // d'un réglage du navigateur coupé par défaut. Elle était d'abord montrée partout (« elle nomme
  // Firefox, un lecteur sur téléphone comprend que ça ne le concerne pas ») ; vue sur iPhone, elle
  // n'était qu'une ligne de bruit dans un panneau voulu épuré — Louis a tranché le 15/10/2026.
  it("shows the card on Firefox for Linux", () => {
    asBrowser(FIREFOX_LINUX);
    render(<PlayerAccountPanel />);
    expect(screen.getByText("player.account.help.hdrTitle")).toBeTruthy();
    expect(screen.getByText("gfx.color_management.hdr")).toBeTruthy();
  });

  it.each([
    ["an iPhone", IPHONE],
    ["Chrome on Linux", CHROME_LINUX],
    ["Firefox on Android", FIREFOX_ANDROID],
    ["Firefox on a Mac", FIREFOX_MAC],
  ])("hides it on %s, which the setting does not concern", (_name, userAgent) => {
    asBrowser(userAgent);
    render(<PlayerAccountPanel />);
    expect(screen.queryByText("player.account.help.hdrTitle")).toBeNull();
  });

  // Le nom du réglage se copie : on ne peut pas faire de lien vers about:config, et le retaper
  // sans faute est le seul endroit où l'utilisateur peut échouer.
  it("copies the setting name", async () => {
    asBrowser(FIREFOX_LINUX);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<PlayerAccountPanel />);
    fireEvent.click(screen.getByText("player.account.help.copy"));

    expect(writeText).toHaveBeenCalledWith("gfx.color_management.hdr");
    expect(await screen.findByText("player.account.help.copied")).toBeTruthy();
  });

  // Un presse-papiers refusé — contexte non sécurisé, permission bloquée — laisse le texte à
  // l'écran : il reste sélectionnable, et le dire vaut mieux qu'un bouton qui ne fait rien.
  it("says so when the clipboard refuses", async () => {
    asBrowser(FIREFOX_LINUX);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });

    render(<PlayerAccountPanel />);
    fireEvent.click(screen.getByText("player.account.help.copy"));

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith("player.account.help.copyFailed"));
    expect(screen.getByText("gfx.color_management.hdr")).toBeTruthy();
  });
});

// Jellyfin range ses préférences sous le nom terminologique de l'ISO 639-2 — `fra`, `deu` — et la
// liste de choix était écrite dans l'autre convention. Un compte réglé sur le français affichait
// donc « peu importe », et le premier réglage touché aurait effacé sa préférence.
describe("PlayerAccountPanel — playback preferences", () => {
  it("shows the language Jellyfin actually stored", async () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: "fra", subtitleLanguage: "fra", subtitleMode: "OnlyForced" };
    render(<PlayerAccountPanel />);

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const [audio, subtitles, mode] = selects.slice(-3);
    expect(audio.value).toBe("fra");
    expect(subtitles.value).toBe("fra");
    expect(mode.value).toBe("OnlyForced");
  });

  // La même langue écrite par un autre client, dans la forme bibliographique.
  it("recognises the other spelling of the same language", () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: "fre", subtitleLanguage: "ger", subtitleMode: "Default" };
    render(<PlayerAccountPanel />);

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(selects.slice(-3)[0].value).toBe("fra");
    expect(selects.slice(-3)[1].value).toBe("deu");
  });

  // Le mode « Smart » existe chez Jellyfin et manquait ici : un compte réglé dessus voyait le
  // premier de la liste, faute de correspondance.
  it("knows every subtitle mode Jellyfin can store", () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: null, subtitleLanguage: null, subtitleMode: "Smart" };
    render(<PlayerAccountPanel />);
    expect((screen.getAllByRole("combobox").slice(-1)[0] as HTMLSelectElement).value).toBe("Smart");
  });

  // Une langue hors de la courte liste doit rester visible : sinon le compte croit n'avoir rien
  // choisi, et l'efface en touchant autre chose.
  it("keeps a language it does not have a word for", () => {
    payload = { username: "louis", jfUser: "louis", audioLanguage: "rus", subtitleLanguage: null, subtitleMode: "Default" };
    render(<PlayerAccountPanel />);

    const audio = screen.getAllByRole("combobox").slice(-3)[0] as HTMLSelectElement;
    expect(audio.value).toBe("rus");
    expect(screen.getByText("RUS")).toBeTruthy();
  });
});

/**
 * Comment on va voir l'état des services — c'est-à-dire ce qu'on laisse derrière soi.
 *
 * La séance de lecture ne vit qu'en mémoire, dans `PlaybackProvider`. Un `<a>` nu vers `/status`
 * est une navigation de document : la page est déchargée, la séance meurt avec elle, et rien ne
 * la rouvre au retour — la seule qu'un rechargement sache restaurer est celle du changement de
 * piste sous WebKit. Le symptôme signalé en production : le mini-lecteur tué en ouvrant la page
 * d'état. Le DOM ne distingue pas les deux formes, d'où le marqueur posé sur le mock.
 */
describe("PlayerAccountPanel — la porte vers l'état des services", () => {
  it("y va par une navigation client, sans décharger la page ni la séance en cours", () => {
    payload = { username: "louis", jfUser: "louis" };
    render(<PlayerAccountPanel />);

    const link = screen.getByRole("link", { name: /player\.account\.openStatus/ });
    expect(link.getAttribute("href")).toBe("/status?from=compte");
    expect(link.getAttribute("data-client-nav")).toBe("1");
  });
});

// L'ordre du 13/10/2026 (DECISIONS.md §7 quater) : langues, compte, notifications, interface, aide
// à plat, puis l'outillage de l'administrateur ; « Se déconnecter » après tout le reste.
describe("PlayerAccountPanel — l'ordre de la page", () => {
  const groups = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
  const cardOf = (title: string) => screen.getByRole("heading", { level: 2, name: title }).nextElementSibling as HTMLElement;
  const follows = (a: string, b: string) =>
    Boolean(screen.getByText(a).compareDocumentPosition(screen.getByText(b)) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("range la page en groupes, sans l'administration pour un compte ordinaire", () => {
    payload = { username: "sarah", jfUser: "sarah", role: "user" };
    render(<PlayerAccountPanel />);
    expect(groups()).toEqual([
      "player.account.groups.preferences",
      "player.account.groups.account",
      "player.account.notifications",
      "player.account.display",
      "player.account.groups.help",
    ]);
  });

  it("met la langue de l'application avant les langues de lecture, et le mot de passe avant les appareils", () => {
    payload = { username: "sarah", jfUser: "sarah", role: "user" };
    render(<PlayerAccountPanel />);
    expect(follows("player.account.language", "player.account.playback")).toBe(true);
    expect(follows("player.account.password", "player.account.devices")).toBe(true);
    // Le cache de l'appareil a quitté le groupe Compte pour l'Aide.
    expect(within(cardOf("player.account.groups.account")).queryByText("player.account.storage")).toBeNull();
    expect(within(cardOf("player.account.groups.help")).getByText("player.account.storage")).toBeTruthy();
  });

  it("l'Interface : les reprises dans la bannière, puis le défilement guidé — et plus d'option pour le bouton « Tous »", () => {
    payload = { username: "sarah", jfUser: "sarah", role: "user" };
    render(<PlayerAccountPanel />);
    const card = cardOf("player.account.display");
    const titles = within(card).getAllByRole("switch", { hidden: true }).map((s) => s.getAttribute("aria-label"));
    expect(titles).toEqual(["player.account.home.continueHero", "player.account.guidedScroll"]);
    expect(screen.queryByText("player.account.home.browseButton")).toBeNull();
  });

  // Tout au même niveau : une liste de lignes de même dessin, sans section ni carte dans la carte.
  it("met toute l'aide à plat, dans l'ordre voulu", () => {
    payload = { username: "sarah", jfUser: "sarah", role: "user" };
    // Le seul navigateur où l'aide HDR paraît : l'ordre se vérifie avec toutes les lignes.
    asBrowser(FIREFOX_LINUX);
    render(<PlayerAccountPanel />);
    const card = cardOf("player.account.groups.help");
    expect(card.querySelector("section")).toBeNull();
    expect(card.querySelector("ul, .rounded-xl")).toBeNull();
    const rows = Array.from(card.children);
    expect(rows.every((r) => r.hasAttribute("data-row"))).toBe(true);
    const text = rows.map((r) => r.textContent ?? "");
    const order = [
      "news.title",
      "player.account.redoOnboarding",
      "player.account.status",
      "player.account.help.hdrTitle",
      "player.account.storage",
      "player.account.report",
    ];
    expect(order.map((key) => text.findIndex((t) => t.startsWith(key)))).toEqual(order.map((_, i) => i));
    // Signaler et « Mes signalements » sur la même ligne (13/10/2026).
    expect(text.at(-1)).toContain("player.account.reportNew");
    expect(text.at(-1)).toContain("player.account.reportMine");
  });

  it("rassemble l'outillage de l'administrateur à la fin, dans l'ordre voulu, et la déconnexion après tout le reste", () => {
    payload = { username: "louis", jfUser: "louis", role: "admin" };
    render(<PlayerAccountPanel />);
    expect(groups().at(-1)).toBe("player.account.groups.admin");
    const admin = screen.getByText("player.account.groups.admin");
    const logout = screen.getByText("player.account.signOutAction");
    expect(admin.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const titles = within(cardOf("player.account.groups.admin"))
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(titles).toEqual([
      "player.account.activity",
      "player.account.maintenance",
      "player.account.lab",
      "player.nav.manage",
    ]);
    // Le banc d'essai et les tests divers sur la même ligne « Lab » (13/10/2026).
    const lab = within(cardOf("player.account.groups.admin")).getByText("player.account.lab").closest("section")!;
    expect(within(lab).getByText("bench.prepareShort")).toBeTruthy();
    expect(within(lab).getByText("player.account.openAnimLab")).toBeTruthy();
  });

  // Trois champs ouverts en permanence occupaient un écran de téléphone pour un geste annuel.
  it("replie le mot de passe jusqu'à ce qu'on le demande", () => {
    payload = { username: "sarah", jfUser: "sarah", role: "user" };
    render(<PlayerAccountPanel />);
    expect(screen.queryByPlaceholderText("player.account.currentPassword")).toBeNull();
    fireEvent.click(screen.getByText("player.account.changePassword"));
    expect(screen.getByPlaceholderText("player.account.currentPassword")).toBeTruthy();
    fireEvent.click(screen.getByText("common.cancel"));
    expect(screen.queryByPlaceholderText("player.account.currentPassword")).toBeNull();
  });

  it("choisit la langue dans une liste, et prévient du rechargement", () => {
    payload = { username: "sarah", jfUser: "sarah", role: "user" };
    render(<PlayerAccountPanel />);
    fireEvent.change(screen.getByLabelText("player.account.appLanguage"), { target: { value: "en" } });
    expect(screen.getByText("settings.language.reloadNotice")).toBeTruthy();
  });
});

// Tant que la réponse n'était pas là, le panneau annonçait « compte local » à tout le monde, puis
// sautait quand la lecture et le mot de passe apparaissaient (23/09/2026).
describe("PlayerAccountPanel — pendant le chargement", () => {
  it("ne prétend pas que le compte est local avant de le savoir", () => {
    payload = undefined as never;
    render(<PlayerAccountPanel />);
    expect(screen.queryByText("player.account.localAccountHint")).toBeNull();
    expect(screen.getByText("player.account.changePassword")).toBeTruthy();
  });
});
