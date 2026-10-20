// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";

/**
 * Le côté administrateur des liens de partage (DECISIONS.md §112) : le bouton de la fiche n'existe
 * que pour l'administrateur, la fenêtre envoie ce que la route attend et garde le mot de passe
 * affiché une fois créé ; la vue Partages de l'Activité dit l'état de chaque lien et en fait les
 * gestes — prolonger, révoquer, supprimer. Le serveur est simulé ; les phrases sont celles du vrai
 * dictionnaire français.
 */
const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>, "fr");
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => ({ locale: "fr", setLocale: async () => {} }) }));
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: () => {} }));
const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ info: () => {}, success: (m: string) => toasts.success.push(m), error: (m: string) => toasts.error.push(m) }),
}));

import { ShareButton } from "@/components/share/ShareControl";
import { ActivityShares } from "@/components/activity/views/ActivityShares";
import { SHARE_DAYS_CHOICES, SHARE_LABEL_MAX_CLIENT, SHARE_MAX_STREAMS_CLIENT, copyText } from "@/components/share/shareClient";

const NOW = Date.parse("2026-10-20T20:00:00Z");
const MOVIE = "a".repeat(32);
const ACTIVE = "1".repeat(16);
const EXPIRED = "2".repeat(16);
const GONE = "3".repeat(16);

type Call = { url: string; method: string; body: unknown };
let role: "admin" | "user";
let calls: Call[];
let shares: Record<string, unknown>[];
let createAnswer: { status: number; body: unknown };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function summary(over: Record<string, unknown>) {
  return {
    code: "abcdefghjk",
    path: "/partage/abcdefghjk",
    kind: "movie",
    itemId: MOVIE,
    title: "1917",
    label: "Paul",
    createdBy: "louis",
    createdAt: NOW - 2 * 86400_000,
    expiresAt: NOW + 5 * 86400_000,
    revokedAt: null,
    state: "active",
    accountDeleted: false,
    maxStreams: 3,
    redeemed: 0,
    lastUsedAt: null,
    lastIp: null,
    lastDevice: null,
    playingNow: 0,
    nowPlaying: null,
    usage: { seances: 0, watchedSeconds: 0, dataMB: 0, lastSeance: null },
    ...over,
  };
}

beforeEach(() => {
  role = "admin";
  calls = [];
  toasts.success.length = 0;
  toasts.error.length = 0;
  createAnswer = {
    status: 200,
    body: { id: ACTIVE, code: "abcdefghjk", path: "/partage/abcdefghjk", password: "k7fm-2qxp-9tre", expiresAt: NOW + 7 * 86400_000, title: "1917", label: "Paul" },
  };
  shares = [
    summary({ id: EXPIRED, title: "Dune", label: "Marie", state: "expired", createdAt: NOW - 20 * 86400_000, expiresAt: NOW - 86400_000 }),
    summary({
      id: ACTIVE,
      redeemed: 2,
      lastUsedAt: NOW - 10 * 60_000,
      lastIp: "203.0.113.7",
      lastDevice: "Safari · iPhone",
      playingNow: 1,
      nowPlaying: { itemId: MOVIE, title: "1917" },
      usage: { seances: 3, watchedSeconds: 7500, dataMB: 2400, lastSeance: { at: NOW - 600_000, title: "1917", positionSeconds: 3723, device: "Safari · iPhone" } },
    }),
    summary({ id: GONE, title: "Ted Lasso", kind: "series", label: "Zoé", state: "revoked", createdAt: NOW - 60 * 86400_000, revokedAt: NOW - 40 * 86400_000, accountDeleted: true }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url === "/api/auth/me") return json({ role, username: role === "admin" ? "louis" : "lucas", jfId: null, jfUser: null });
      if (url === "/api/admin/shares" && method === "POST") return json(createAnswer.body, createAnswer.status);
      if (url === "/api/admin/shares") return json({ now: NOW, shares });
      if (method === "DELETE") {
        shares = shares.filter((s) => !url.endsWith(String(s.id)));
        return json({ ok: true });
      }
      if (method === "PATCH") return json({ ok: true });
      return json({ error: "inattendu" }, 500);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fresh = (children: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;

function mountButton(over: Partial<React.ComponentProps<typeof ShareButton>> = {}) {
  render(fresh(<ShareButton kind="movie" itemId={MOVIE} radarrId={42} title="1917" year={2019} posterUrl={null} variant="wide" {...over} />));
}

describe("ShareButton", () => {
  it("n'existe pas pour un compte qui n'est pas administrateur", async () => {
    role = "user";
    mountButton();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/auth/me")).toBe(true));
    // Le temps que la réponse arrive et soit rendue : toujours rien.
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Partager par un lien/ })).toBeNull();
  });

  it("crée le lien avec ce que la route attend, puis montre l'adresse et le mot de passe", async () => {
    mountButton();
    fireEvent.click(await screen.findByRole("button", { name: /Partager par un lien/ }));
    const create = await screen.findByRole("button", { name: "Créer le lien" });
    // Sans nom, rien ne part.
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Pour qui ?"), { target: { value: "  Paul " } });
    expect(screen.getByRole("radio", { name: "7 jours" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "14 jours" }));
    fireEvent.click(create);

    const result = await screen.findByTestId("share-result");
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      { url: "/api/admin/shares", method: "POST", body: { kind: "movie", itemId: MOVIE, radarrId: 42, label: "Paul", days: 14 } },
    ]);
    expect(result.textContent).toContain(`${window.location.origin}/partage/abcdefghjk`);
    expect(result.textContent).toContain("k7fm-2qxp-9tre");
    expect(result.textContent).toContain("Ce mot de passe ne sera plus affiché.");
    expect(result.textContent).toContain("Lien pour Paul");
    // La fenêtre est restée ouverte : « Créer le lien » n'est pas une action qui la referme.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("une série part avec son identifiant Sonarr, jamais celui de Radarr", async () => {
    mountButton({ kind: "series", sonarrId: 7, radarrId: 42, title: "Ted Lasso" });
    fireEvent.click(await screen.findByRole("button", { name: /Partager par un lien/ }));
    expect(await screen.findByText("Toute la série, épisodes à venir compris.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Pour qui ?"), { target: { value: "Zoé" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le lien" }));
    await screen.findByTestId("share-result");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ kind: "series", itemId: MOVIE, sonarrId: 7, label: "Zoé", days: 7 });
  });

  it("un refus du serveur s'affiche dans la fenêtre, traduit par son code", async () => {
    createAnswer = { status: 404, body: { error: "Titre introuvable chez Jellyfin", code: "item" } };
    mountButton();
    fireEvent.click(await screen.findByRole("button", { name: /Partager par un lien/ }));
    fireEvent.change(await screen.findByLabelText("Pour qui ?"), { target: { value: "Paul" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le lien" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Ce titre est introuvable dans la bibliothèque.");
    expect(screen.queryByTestId("share-result")).toBeNull();
  });

  it("copie le mot de passe dans le presse-papiers", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mountButton();
    fireEvent.click(await screen.findByRole("button", { name: /Partager par un lien/ }));
    fireEvent.change(await screen.findByLabelText("Pour qui ?"), { target: { value: "Paul" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le lien" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copier le mot de passe" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("k7fm-2qxp-9tre"));
    expect(toasts.success).toContain("Copié");
  });
});

describe("copyText", () => {
  it("ne lève jamais : un presse-papiers qui refuse donne `false` ou le repli", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => Promise.reject(new Error("refusé")) }, configurable: true });
    await expect(copyText("x")).resolves.toBeTypeOf("boolean");
  });
});

describe("ActivityShares", () => {
  const mount = () => render(fresh(<ActivityShares />));

  it("dit l'état, l'usage et ce qui joue, les liens vivants d'abord", async () => {
    mount();
    const rows = await screen.findAllByTestId("share-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("1917");
    expect(rows[0].textContent).toContain("Actif");
    expect(rows[0].textContent).toContain("en lecture · 1/3");
    expect(rows[0].textContent).toContain("invité · Paul");
    expect(rows[0].textContent).toContain("entrées : 2");
    expect(rows[0].textContent).toContain("Safari · iPhone");
    expect(rows[0].textContent).toContain("203.0.113.7");
    expect(rows[0].textContent).toContain("séances : 3");
    expect(rows[0].textContent).toContain("2 h 05 regardées");
    expect(rows[0].textContent).toContain("arrêtée à 1:02:03");
    expect(rows[1].textContent).toContain("Expiré");
    expect(rows[1].textContent).toContain("Jamais ouvert");
    expect(rows[2].textContent).toContain("Révoqué");
    // Les tuiles : un lien actif sur trois, une lecture en cours.
    expect(screen.getByText("3 au total")).toBeInTheDocument();
  });

  it("prolonge, révoque et supprime par les bonnes routes", async () => {
    mount();
    const rows = await screen.findAllByTestId("share-row");

    // Prolonger le lien expiré de 7 jours : il se rouvre.
    fireEvent.click(Array.from(rows[1].querySelectorAll("button")).find((b) => b.textContent === "Prolonger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "+7 j" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/api/admin/shares/${EXPIRED}`, method: "PATCH", body: { action: "extend", days: 7 } }));

    // Révoquer le lien actif : un second appui.
    fireEvent.click(screen.getByRole("button", { name: "Révoquer" }));
    expect(calls.some((c) => c.body && (c.body as { action?: string }).action === "revoke")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Révoquer le lien/ }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/api/admin/shares/${ACTIVE}`, method: "PATCH", body: { action: "revoke" } }));

    // Supprimer le lien révoqué.
    const del = screen.getAllByRole("button", { name: "Supprimer" });
    fireEvent.click(del[del.length - 1]);
    fireEvent.click(screen.getByRole("button", { name: /Supprimer définitivement/ }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/api/admin/shares/${GONE}`, method: "DELETE", body: undefined }));
    await waitFor(() => expect(screen.queryByText("Ted Lasso")).toBeNull());
  });

  it("ne propose pas de prolonger un lien révoqué, et dit pourquoi", async () => {
    mount();
    const rows = await screen.findAllByTestId("share-row");
    const extend = Array.from(rows[2].querySelectorAll("button")).find((b) => b.textContent === "Prolonger");
    expect(extend).toBeDisabled();
    expect(rows[2].textContent).toContain("Un lien révoqué ne se prolonge pas.");
  });
});

describe("les bornes recopiées côté navigateur", () => {
  it("sont celles du serveur", async () => {
    const store = await import("@/lib/share/store");
    expect([...SHARE_DAYS_CHOICES]).toEqual([...store.SHARE_DURATIONS_DAYS]);
    expect(SHARE_LABEL_MAX_CLIENT).toBe(store.SHARE_LABEL_MAX);
    expect(SHARE_MAX_STREAMS_CLIENT).toBe(store.SHARE_MAX_STREAMS);
  });
});
