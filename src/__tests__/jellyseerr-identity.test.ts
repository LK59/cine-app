import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Au nom de qui cine-app parle à Jellyseerr.
 *
 * Le 23/09/2026, une série demandée depuis un compte ordinaire est arrivée dans Jellyseerr au nom
 * de son propriétaire : la session datait d'avant l'import du compte, n'avait donc pas de cookie
 * Jellyseerr, et la demande était partie avec la clé d'API seule. Importer le compte ensuite n'y
 * changeait rien — le cookie ne s'obtient qu'à la connexion.
 */

const { jellyseerr, logError } = vi.hoisted(() => ({
  jellyseerr: { getMe: vi.fn(), getUsers: vi.fn(), importFromJellyfin: vi.fn(), login: vi.fn() },
  logError: vi.fn(),
}));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr }));
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));

import {
  resolveJellyseerrIdentity,
  ensureJellyseerrUserId,
  loginToJellyseerr,
  resetJellyseerrIdentityCache,
} from "@/lib/jellyseerrIdentity";

const SARAH = { id: 23, displayName: "sarah", jellyfinUsername: "sarah", jellyfinUserId: "90625-3c41-4114" };
const session = (extra: Record<string, unknown> = {}) =>
  ({ u: "sarah", role: "user", exp: 0, jti: "j", jfUser: "sarah", jfId: "906253c414114", ...extra }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  resetJellyseerrIdentityCache();
});

describe("resolveJellyseerrIdentity", () => {
  it("garde le cookie de la session quand Jellyseerr l'accepte encore", async () => {
    jellyseerr.getMe.mockResolvedValue({ id: 23 });
    expect(await resolveJellyseerrIdentity(session({ jsCookie: "s%3Ac" }))).toEqual({ cookie: "s%3Ac", userId: 23 });
    expect(jellyseerr.getUsers).not.toHaveBeenCalled();
  });

  // Le cas du 23/09 : pas de cookie, compte bien présent dans Jellyseerr.
  it("sans cookie, retrouve le compte par son identifiant Jellyfin", async () => {
    jellyseerr.getUsers.mockResolvedValue({ results: [{ id: 1, displayName: "louis", jellyfinUsername: "louis" }, SARAH] });
    expect(await resolveJellyseerrIdentity(session())).toEqual({ userId: 23 });
    expect(jellyseerr.importFromJellyfin).not.toHaveBeenCalled();
  });

  it("un cookie refusé ne sert plus : on passe au compte nommé", async () => {
    jellyseerr.getMe.mockRejectedValue(new Error("403"));
    jellyseerr.getUsers.mockResolvedValue({ results: [SARAH] });
    expect(await resolveJellyseerrIdentity(session({ jsCookie: "s%3Aperime" }))).toEqual({ userId: 23 });
  });

  it("l'identifiant prime sur le nom, qui peut avoir changé", async () => {
    jellyseerr.getUsers.mockResolvedValue({
      results: [{ ...SARAH, jellyfinUsername: "sarah-ancien-nom" }, { id: 99, displayName: "x", jellyfinUsername: "sarah" }],
    });
    expect(await resolveJellyseerrIdentity(session())).toEqual({ userId: 23 });
  });

  it("une connexion locale sans identité Jellyfin ne demande rien à Jellyseerr", async () => {
    expect(await resolveJellyseerrIdentity({ u: "admin", role: "admin", exp: 0, jti: "j" } as never)).toEqual({ userId: null });
    expect(jellyseerr.getUsers).not.toHaveBeenCalled();
  });
});

describe("ensureJellyseerrUserId", () => {
  it("importe un compte que Jellyseerr ne connaît pas, puis le retrouve", async () => {
    jellyseerr.getUsers
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [SARAH] });
    jellyseerr.importFromJellyfin.mockResolvedValue([SARAH]);
    expect(await ensureJellyseerrUserId("906253c414114", "sarah")).toBe(23);
    expect(jellyseerr.importFromJellyfin).toHaveBeenCalledWith(["906253c414114"]);
  });

  // Importé à la main entre deux gestes : la liste en mémoire ne le sait pas encore.
  it("relit la liste avant d'importer", async () => {
    jellyseerr.getUsers.mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ results: [SARAH] });
    expect(await ensureJellyseerrUserId("906253c414114", "sarah")).toBe(23);
    expect(jellyseerr.importFromJellyfin).not.toHaveBeenCalled();
  });

  it("un import qui échoue est journalisé et n'est pas retenté à chaque geste", async () => {
    jellyseerr.getUsers.mockResolvedValue({ results: [] });
    jellyseerr.importFromJellyfin.mockRejectedValue(new Error("500"));
    expect(await ensureJellyseerrUserId("906253c414114", "sarah")).toBeNull();
    expect(await ensureJellyseerrUserId("906253c414114", "sarah")).toBeNull();
    expect(jellyseerr.importFromJellyfin).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("jellyseerr-identity", expect.any(Error), expect.objectContaining({ step: "import" }));
  });

  // Jellyseerr qui ne répond pas : le redemander aussitôt doublait l'attente de « Ma liste ».
  it("ne redemande pas la liste quand Jellyseerr vient d'échouer", async () => {
    jellyseerr.getUsers.mockRejectedValue(new Error("timeout"));
    expect(await ensureJellyseerrUserId("906253c414114", "sarah")).toBeNull();
    expect(jellyseerr.getUsers).toHaveBeenCalledTimes(1);
  });

  // Sans liste, on ne sait pas si le compte existe déjà : importer ne dirait rien de plus.
  it("n'importe rien quand Jellyseerr ne répond pas", async () => {
    jellyseerr.getUsers.mockRejectedValue(new Error("down"));
    expect(await ensureJellyseerrUserId("906253c414114", "sarah")).toBeNull();
    expect(jellyseerr.importFromJellyfin).not.toHaveBeenCalled();
  });
});

describe("loginToJellyseerr", () => {
  it("se connecte directement quand le compte existe", async () => {
    jellyseerr.login.mockResolvedValue("s%3Aok");
    expect(await loginToJellyseerr("sarah", "pw", "906253c414114", "sarah")).toBe("s%3Aok");
    expect(jellyseerr.getUsers).not.toHaveBeenCalled();
  });

  // Ce qui dispense d'importer chaque nouveau compte avant sa première connexion.
  it("importe un nouveau compte puis réessaie une fois", async () => {
    jellyseerr.login.mockResolvedValueOnce(null).mockResolvedValueOnce("s%3Aapres-import");
    jellyseerr.getUsers
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [SARAH] });
    jellyseerr.importFromJellyfin.mockResolvedValue([SARAH]);
    expect(await loginToJellyseerr("sarah", "pw", "906253c414114", "sarah")).toBe("s%3Aapres-import");
    expect(jellyseerr.login).toHaveBeenCalledTimes(2);
  });

  it("ne réessaie pas quand le compte reste introuvable", async () => {
    jellyseerr.login.mockResolvedValue(null);
    jellyseerr.getUsers.mockRejectedValue(new Error("down"));
    expect(await loginToJellyseerr("sarah", "pw", "906253c414114", "sarah")).toBeNull();
    expect(jellyseerr.login).toHaveBeenCalledTimes(1);
  });
});
