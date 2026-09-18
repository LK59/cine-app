import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

// La base, réduite à ce que la route lui demande : un état, et deux façons de l'écrire.
// `vi.hoisted` parce que `vi.mock` est remonté en tête de fichier : sa fabrique s'exécute avant
// toute déclaration de module, et ne peut donc pas lire une variable déclarée plus bas.
const { store, maintenanceDb } = vi.hoisted(() => {
  const store = { state: { active: false, noticeAt: null as number | null, expiresAt: null as number | null } };
  return {
    store,
    maintenanceDb: {
      get: vi.fn(() => store.state),
      setActive: vi.fn((active: boolean) => {
        store.state = { ...store.state, active, expiresAt: active ? Date.now() + 1000 : null };
        return store.state;
      }),
      raiseNotice: vi.fn((at = Date.now()) => {
        store.state = { ...store.state, noticeAt: at };
        return store.state;
      }),
    },
  };
});
vi.mock("@/lib/db", () => ({ maintenanceDb }));

import { GET, POST } from "@/app/api/maintenance/route";

/**
 * Une requête, avec ou sans cookie de session.
 *
 * Le rôle n'apparaît nulle part ici, et c'est volontaire : `src/proxy.ts` refuse déjà tout POST
 * sur `/api/` à un compte ordinaire, et cette route n'est pas dans sa liste blanche. Une seconde
 * vérification ici serait une seconde règle à maintenir — et deux règles finissent par diverger.
 */
function request(body?: unknown, signedIn = true): NextRequest {
  return {
    cookies: { get: () => (signedIn ? { value: "jeton" } : undefined) },
    json: async () => {
      if (body === undefined) throw new Error("pas de corps");
      return body;
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.state = { active: false, noticeAt: null, expiresAt: null };
  mockVerify.mockResolvedValue({ u: "louis", role: "admin" });
});

describe("l'état d'exploitation", () => {
  it("répond que rien n'est en cours sur une installation qui n'a jamais rien allumé", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false, noticeAt: null, expiresAt: null });
  });

  it("se tait devant une requête sans session", async () => {
    const res = await GET(request(undefined, false));
    expect(res.status).toBe(401);
    expect(maintenanceDb.get).not.toHaveBeenCalled();
  });

  it("allume, puis éteint", async () => {
    expect(await (await POST(request({ active: true }))).json()).toMatchObject({ active: true });
    expect(await (await POST(request({ active: false }))).json()).toMatchObject({ active: false });
  });

  it("lève un avis daté sans toucher au bandeau", async () => {
    // Les deux gestes sont distincts : prévenir d'un redémarrage n'allume pas le bandeau, et
    // les confondre rendrait impossible d'avertir sans d'abord afficher autre chose.
    const body = (await (await POST(request({ notice: true }))).json()) as { active: boolean; noticeAt: number };
    expect(body.active).toBe(false);
    expect(body.noticeAt).toBeGreaterThan(0);
    expect(maintenanceDb.setActive).not.toHaveBeenCalled();
  });

  it("fait les deux d'un coup quand on le lui demande", async () => {
    // Le geste le plus probable avant un redéploiement : allumer le bandeau et prévenir ceux
    // qui regardent, en une fois.
    const body = (await (await POST(request({ active: true, notice: true }))).json()) as {
      active: boolean;
      noticeAt: number;
    };
    expect(body.active).toBe(true);
    expect(body.noticeAt).toBeGreaterThan(0);
  });

  it("donne un avis plus récent à chaque appel", async () => {
    // C'est une date et non un drapeau : deux avertissements successifs doivent tous deux
    // atteindre un écran qui a déjà vu le premier.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const first = (await (await POST(request({ notice: true }))).json()) as { noticeAt: number };
      vi.setSystemTime(2000);
      const second = (await (await POST(request({ notice: true }))).json()) as { noticeAt: number };
      expect(second.noticeAt).toBeGreaterThan(first.noticeAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuse une demande qui ne demande rien", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(400);
    expect(maintenanceDb.setActive).not.toHaveBeenCalled();
    expect(maintenanceDb.raiseNotice).not.toHaveBeenCalled();
  });

  it("refuse un corps illisible plutôt que de le deviner", async () => {
    const res = await POST(request());
    expect(res.status).toBe(400);
  });

  it("n'écrit rien sans session", async () => {
    const res = await POST(request({ active: true }, false));
    expect(res.status).toBe(401);
    expect(maintenanceDb.setActive).not.toHaveBeenCalled();
  });
});
