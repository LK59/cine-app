import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L'entrée hors ligne des téléchargements dans le service worker (19/10/2026, DECISIONS.md §109) :
 * `/hors-ligne` et son code gardés pour le build, servis sans réseau, et la navigation lente.
 */

const ORIGIN = "https://cine.example";
const keyOf = (req: Request | string) => new URL(typeof req === "string" ? req : req.url, ORIGIN).href;

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request | string) {
    const hit = this.store.get(keyOf(req));
    return hit ? hit.clone() : undefined;
  }
  async put(req: Request | string, res: Response) {
    this.store.set(keyOf(req), res);
  }
  async addAll(paths: string[]) {
    for (const p of paths) this.store.set(keyOf(p), new Response(`precache ${p}`));
  }
}

let names: string[];
let caches: Map<string, FakeCache>;
let listeners: Record<string, (event: Record<string, unknown>) => void>;
let network: ReturnType<typeof vi.fn>;

function worker(build = "b1") {
  listeners = {};
  const storage = {
    open: async (name: string) => {
      if (!caches.has(name)) {
        caches.set(name, new FakeCache());
        names.push(name);
      }
      return caches.get(name)!;
    },
    keys: async () => [...names],
    delete: async (name: string) => {
      caches.delete(name);
      names = names.filter((n) => n !== name);
      return true;
    },
    match: async (req: Request | string) => {
      for (const name of names) {
        const hit = await caches.get(name)!.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const scope = {
    location: { href: `${ORIGIN}/sw.js?v=${build}` },
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      listeners[type] = handler;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn() },
    registration: { showNotification: vi.fn() },
  };
  const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", source)(scope, storage, network);
  return storage;
}

const OFFLINE_HTML = readFileSync(join(process.cwd(), "public/offline.html"), "utf8");

/** Le serveur : la page sans cookie, trois fichiers dont un chargé à la demande, une police dans la CSS. */
let routes: Record<string, () => Response | Promise<Response>>;
const defaultRoutes = (): typeof routes => ({
  "/hors-ligne": () =>
    new Response('<html><script src="/_next/static/chunks/main.js"></script><link href="/_next/static/chunks/app.css"></html>', {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  "/_next/static/chunks/main.js": () => new Response('t.v(()=>Promise.all(["static/chunks/lecteur.js"].map(c=>t.l(c))))'),
  "/_next/static/chunks/lecteur.js": () => new Response("lecteur"),
  "/_next/static/chunks/app.css": () => new Response("@font-face{src:url(../media/inter.woff2)}"),
  "/_next/static/media/inter.woff2": () => new Response("police"),
});

/** Le worker reçoit `fetch` à sa création : on change les routes, jamais la fonction. */
function server(over: Record<string, () => Response | Promise<Response>> = {}) {
  Object.assign(routes, over);
}

async function install() {
  let done: Promise<unknown> = Promise.resolve();
  listeners.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
}

async function warm() {
  let done: Promise<unknown> = Promise.resolve();
  listeners.message({ data: { type: "cine:warm-offline-entry" }, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
}

function navigation(path: string): Request {
  const request = new Request(`${ORIGIN}${path}`);
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

function dispatch(request: Request): Promise<Response> {
  let answered: Promise<Response> | Response | null = null;
  listeners.fetch({ request, respondWith: (r: Promise<Response> | Response) => (answered = r), waitUntil: () => {} });
  if (!answered) throw new Error("non intercepté");
  return Promise.resolve(answered);
}

beforeEach(() => {
  names = [];
  caches = new Map();
  routes = defaultRoutes();
  network = vi.fn(async (input: Request | string) => {
    const route = routes[new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname];
    return route ? route() : new Response("absent", { status: 404 });
  });
});
afterEach(() => vi.useRealTimers());

describe("la mise en réserve de /hors-ligne", () => {
  it("demande la page sans cookie, puis tout le code qu'elle atteint, et la range en dernier", async () => {
    worker();
    await warm();
    const [first, init] = network.mock.calls[0];
    expect(new URL(String(first)).pathname).toBe("/hors-ligne");
    expect(init).toMatchObject({ credentials: "omit" });
    const cache = caches.get("cine-static-b1")!;
    expect([...cache.store.keys()].map((k) => new URL(k).pathname)).toEqual([
      "/_next/static/chunks/main.js",
      "/_next/static/chunks/app.css",
      "/_next/static/chunks/lecteur.js",
      "/_next/static/media/inter.woff2",
      "/hors-ligne",
    ]);
  });

  it("une fois par build : rien n'est redemandé quand elle est déjà là", async () => {
    worker();
    await warm();
    const calls = network.mock.calls.length;
    await warm();
    expect(network.mock.calls.length).toBe(calls);
  });

  it("un réseau qui lâche en route : la page n'est pas rangée, la prochaine demande reprend", async () => {
    server({ "/_next/static/chunks/lecteur.js": () => Promise.reject(new TypeError("Failed to fetch")) });
    worker();
    await warm();
    expect(await caches.get("cine-static-b1")!.match("/hors-ligne")).toBeUndefined();
  });

  it("une page qui n'est pas du HTML (une redirection, une erreur) n'est pas gardée", async () => {
    server({ "/hors-ligne": () => new Response("", { status: 500 }) });
    worker();
    await warm();
    expect(await caches.get("cine-static-b1")!.match("/hors-ligne")).toBeUndefined();
  });
});

describe("les navigations", () => {
  it("sans réseau, /hors-ligne est servie depuis la réserve", async () => {
    worker();
    await install();
    await warm();
    server({ "/hors-ligne": () => Promise.reject(new TypeError("offline")) });
    const res = await dispatch(navigation("/hors-ligne"));
    expect(await res.text()).toContain("/_next/static/chunks/main.js");
  });

  it("sans réseau, une autre page reçoit « Pas de connexion » — dont le bouton mène à la réserve", async () => {
    worker();
    await install();
    await warm();
    server({ "/": () => Promise.reject(new TypeError("offline")) });
    const res = await dispatch(navigation("/"));
    expect(await res.text()).toBe(`precache /offline.html`);
  });

  it("un appareil sans réserve ne fait jamais attendre autrement qu'avant", async () => {
    vi.useFakeTimers();
    worker();
    let release: (r: Response) => void = () => {};
    server({ "/": () => new Promise<Response>((resolve) => (release = resolve)) });
    const pending = dispatch(navigation("/"));
    await vi.advanceTimersByTimeAsync(20_000);
    release(new Response("accueil"));
    expect(await (await pending).text()).toBe("accueil");
  });

  it("lente sur un appareil qui a la réserve : la page d'attente, puis la réponse elle-même au rechargement", async () => {
    worker();
    await install();
    await caches.get("cine-app-v12")!.put("/offline.html", new Response(OFFLINE_HTML));
    await warm();
    vi.useFakeTimers();
    let release: (r: Response) => void = () => {};
    let asked = 0;
    server({
      "/": () => {
        asked += 1;
        return new Promise<Response>((resolve) => (release = resolve));
      },
    });
    const first = dispatch(navigation("/"));
    await vi.advanceTimersByTimeAsync(6_000);
    const waiting = await (await first).text();
    expect(waiting).toContain('<html data-attente="1"');

    // La page d'attente guette ; la réponse arrive ; elle se recharge et la reçoit sans nouvelle requête.
    const state = dispatch(new Request(`${ORIGIN}/__sw/attente?url=${encodeURIComponent(`${ORIGIN}/`)}`));
    release(new Response("accueil"));
    expect(await (await state).json()).toEqual({ state: "ready" });
    const reloaded = await dispatch(navigation("/#film=920"));
    expect(await reloaded.text()).toBe("accueil");
    expect(asked).toBe(1);
  });

  it("une réponse rapide passe telle quelle, même avec la réserve", async () => {
    worker();
    await warm();
    server({ "/": () => new Response("accueil") });
    expect(await (await dispatch(navigation("/"))).text()).toBe("accueil");
  });

  it("rien de gardé : la page d'attente l'apprend (`none`)", async () => {
    worker();
    const res = await dispatch(new Request(`${ORIGIN}/__sw/attente?url=${encodeURIComponent(`${ORIGIN}/`)}`));
    expect(await res.json()).toEqual({ state: "none" });
  });
});
