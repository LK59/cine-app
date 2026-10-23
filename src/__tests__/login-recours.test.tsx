// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * Le bas de la page de connexion (23/10/2026) : la porte de service (la connexion administrateur de
 * secours) et l'état des services sur une même ligne centrée, qui passe à la ligne plutôt que de
 * déborder ; le formulaire de secours s'ouvre **sous** cette ligne, sur toute la largeur ; le lien
 * de partage garde sa place, après.
 */

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/AppSignature", () => ({ AppSignature: () => null }));
vi.mock("@/lib/liquidGlass/useLiquidDelegation", () => ({ useLiquidDelegation: () => {} }));
vi.mock("@/lib/signOut", () => ({ hardNavigate: () => {}, nextWithFragment: (v: string | null) => v, safeNextPath: (_: unknown, d: string) => d }));

import LoginPage from "@/app/login/page";

afterEach(cleanup);

describe("connexion — la ligne des recours", () => {
  it("la porte de service et l'état des services sont côte à côte, centrés, sur une ligne qui peut passer à la ligne", () => {
    render(<LoginPage />);
    const porte = screen.getByRole("button", { name: "auth.local.heading" });
    const etat = screen.getByRole("link", { name: /auth\.statusLink/ });
    expect(etat.getAttribute("href")).toBe("/status");
    const ligne = porte.parentElement!;
    expect(etat.parentElement).toBe(ligne);
    expect(ligne.className).toMatch(/\bflex\b/);
    expect(ligne.className).toMatch(/\bflex-wrap\b/);
    expect(ligne.className).toMatch(/\bjustify-center\b/);
    // Rien d'autre sur cette ligne.
    expect(ligne.children).toHaveLength(2);
    expect(porte.getAttribute("aria-expanded")).toBe("false");
  });

  it("dépliée, la porte de service ouvre son formulaire sous la ligne, pleine largeur, et la ligne reste", () => {
    const { container } = render(<LoginPage />);
    const porte = screen.getByRole("button", { name: "auth.local.heading" });
    const ligne = porte.parentElement!;
    expect(container.querySelector("#login-local-form")).toBeNull();

    fireEvent.click(porte);

    const form = container.querySelector("#login-local-form") as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(ligne.contains(form)).toBe(false);
    // Le formulaire suit la ligne dans le même bloc : il s'ouvre dessous.
    expect(ligne.nextElementSibling).toBe(form);
    expect(form.className).toMatch(/\bw-full\b/);
    expect(porte.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: /auth\.statusLink/ }).parentElement).toBe(ligne);

    // Le même bouton le replie.
    fireEvent.click(porte);
    expect(container.querySelector("#login-local-form")).toBeNull();
  });

  it("le lien de partage garde sa place, après les recours", () => {
    render(<LoginPage />);
    const partage = screen.getByRole("link", { name: "share.guest.loginButton" });
    expect(partage.getAttribute("href")).toBe("/partage");
    const recours = screen.getByRole("button", { name: "auth.local.heading" }).closest("[data-login-recours]")!;
    expect(recours.nextElementSibling).toBe(partage);
  });
});
