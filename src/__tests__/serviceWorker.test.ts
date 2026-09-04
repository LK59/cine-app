import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Le service worker est un fichier statique, pas un module : il est chargé ici dans un faux
 * environnement de worker pour que ses décisions soient vérifiables.
 *
 * Ce qui est éprouvé n'est pas son écriture mais sa politique — ce qu'il garde et ce qu'il
 * refuse de garder. Une page HTML mise en cache par un déploiement puis servie au suivant est
 * la cause de la famille d'erreurs d'hydratation de React relevée en direct (#419).
 */
type Handler = (event: FakeEvent) => void;
interface FakeEvent {
  request: Request;
  respondWith: (r: Promise<Response> | Response) => void;
  waitUntil?: (p: Promise<unknown>) => void;
}

const put = vi.fn();
let listeners: Record<string, Handler>;

function loadWorker(fetchImpl: typeof fetch) {
  listeners = {};
  put.mockClear();
  const cache = { put, match: vi.fn().mockResolvedValue(undefined), addAll: vi.fn().mockResolvedValue(undefined) };
  const scope = {
    addEventListener: (type: string, handler: Handler) => { listeners[type] = handler; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn() },
    registration: { showNotification: vi.fn() },
    caches: {
      open: vi.fn().mockResolvedValue(cache),
      match: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    },
    fetch: fetchImpl,
  };
  const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", `${source}`)(scope, scope.caches, fetchImpl);
  return scope;
}

/** Rejoue une requête à travers le worker et rend la réponse qu'il a choisie. */
async function through(request: Request): Promise<Response | null> {
  let answered: Promise<Response> | Response | null = null;
  listeners.fetch({ request, respondWith: (r) => { answered = r; } });
  return answered ? await answered : null;
}

const html = (ok = true) => new Response("<!doctype html>", { status: ok ? 200 : 500 });

beforeEach(() => {
  vi.stubGlobal("Response", Response);
  vi.stubGlobal("Request", Request);
});

describe("le service worker", () => {
  it("ne met jamais un document HTML en cache", async () => {
    loadWorker(vi.fn().mockResolvedValue(html()) as unknown as typeof fetch);
    const request = new Request("https://cine.example/cinema");
    Object.defineProperty(request, "mode", { value: "navigate" });

    await through(request);
    expect(put).not.toHaveBeenCalled();
  });

  it("garde en revanche ce qui n'est pas un document", async () => {
    loadWorker(vi.fn().mockResolvedValue(new Response("body")) as unknown as typeof fetch);
    const request = new Request("https://cine.example/manifest.json");
    Object.defineProperty(request, "mode", { value: "cors" });

    await through(request);
    await new Promise((r) => setTimeout(r, 0));
    expect(put).toHaveBeenCalled();
  });

  /** Garder une erreur revient à la resservir une fois le réseau revenu. */
  it("ne met pas une réponse d'erreur en cache", async () => {
    loadWorker(vi.fn().mockResolvedValue(new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const request = new Request("https://cine.example/manifest.json");
    Object.defineProperty(request, "mode", { value: "cors" });

    await through(request);
    await new Promise((r) => setTimeout(r, 0));
    expect(put).not.toHaveBeenCalled();
  });

  /** Les charges utiles de navigation de Next ne passent pas par lui du tout. */
  it("laisse passer les requêtes RSC sans y toucher", async () => {
    loadWorker(vi.fn().mockResolvedValue(html()) as unknown as typeof fetch);
    const request = new Request("https://cine.example/cinema?_rsc=abc");
    expect(await through(request)).toBeNull();
  });

  it("laisse passer les appels d'API sans y toucher", async () => {
    loadWorker(vi.fn().mockResolvedValue(new Response("{}")) as unknown as typeof fetch);
    expect(await through(new Request("https://cine.example/api/dashboard"))).toBeNull();
  });
});
