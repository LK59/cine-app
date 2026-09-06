// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SESSION_EXPIRED_HEADER, noteUnauthorized, resetSessionExpiredForTests } from "@/lib/sessionExpired";

function res(headers: Record<string, string>): Response {
  return { headers: new Headers(headers) } as Response;
}

let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSessionExpiredForTests();
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/", search: "", replace },
  });
});

describe("noteUnauthorized", () => {
  it("renvoie à la connexion, en gardant la place", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/gestion", search: "?onglet=disques", replace },
    });
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    expect(replace).toHaveBeenCalledWith("/login?next=%2Fgestion%3Fonglet%3Ddisques");
  });

  it("ignore un 401 qui ne vient pas de la session — un service amont, une clé d'API", () => {
    noteUnauthorized(res({}));
    expect(replace).not.toHaveBeenCalled();
  });

  it("ne redirige qu'une fois, quel que soit le nombre de requêtes en vol", () => {
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("ne boucle pas depuis la page de connexion, qui appelle des routes protégées", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/login", search: "", replace },
    });
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    expect(replace).not.toHaveBeenCalled();
  });

  it("ne lève pas sur une réponse sans en-têtes, pour ne pas effacer le message du serveur", () => {
    expect(() => noteUnauthorized({} as Response)).not.toThrow();
    expect(replace).not.toHaveBeenCalled();
  });
});
