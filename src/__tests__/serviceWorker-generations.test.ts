import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Le code par génération (21/09/2026) : le cache ne grossit plus à chaque déploiement.
 *
 * Un faux `CacheStorage` à plusieurs caches, ordonnés par création comme le veut la spécification :
 * c'est cet ordre qui désigne la génération précédente.
 */
type Handler = (event: {
  request: Request;
  respondWith: (r: Promise<Response> | Response) => void;
  waitUntil: (p: Promise<unknown>) => void;
}) => void;

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request) {
    const hit = this.store.get(req.url);
    return hit ? hit.clone() : undefined;
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res);
  }
  async addAll() {}
}

let names: string[];
let caches: Map<string, FakeCache>;
let listeners: Record<string, Handler>;
let network: ReturnType<typeof vi.fn>;

function worker(build: string) {
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
    match: async () => undefined,
  };
  const scope = {
    location: { href: `https://cine.example/sw.js?v=${build}` },
    addEventListener: (type: string, handler: Handler) => {
      listeners[type] = handler;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn() },
    registration: { showNotification: vi.fn() },
  };
  currentScope = scope;
  const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", source)(scope, storage, network);
}

let currentScope: { clients: { matchAll: ReturnType<typeof vi.fn> } };
const lastScope = () => currentScope;

async function activate() {
  let done: Promise<unknown> = Promise.resolve();
  listeners.activate({ request: new Request("https://cine.example/"), respondWith: () => {}, waitUntil: (p) => (done = p) });
  await done;
}

async function get(path: string, init: RequestInit = {}): Promise<Response | null> {
  let answered: Promise<Response> | Response | null = null;
  listeners.fetch({
    request: new Request(`https://cine.example${path}`, init),
    respondWith: (r) => (answered = r),
    waitUntil: () => {},
  });
  const res = answered ? await answered : null;
  await new Promise((r) => setTimeout(r, 0));
  return res;
}

beforeEach(() => {
  names = [];
  caches = new Map();
  network = vi.fn(async () => new Response("chunk"));
});

describe("le cache du code, par génération", () => {
  it("range le code du build en cours sous son nom", async () => {
    worker("aaa");
    await get("/_next/static/chunks/app.js");
    expect(names).toContain("cine-static-aaa");
    expect(caches.get("cine-static-aaa")!.store.size).toBe(1);
  });

  it("reprend du build précédent un fichier resté identique, sans le retélécharger", async () => {
    worker("aaa");
    await get("/_next/static/chunks/mediabunny.js");
    expect(network).toHaveBeenCalledTimes(1);

    worker("bbb");
    await activate();
    const res = await get("/_next/static/chunks/mediabunny.js");
    expect(await res!.text()).toBe("chunk");
    expect(network).toHaveBeenCalledTimes(1);
    expect(caches.get("cine-static-bbb")!.store.size).toBe(1);
  });

  it("ne garde jamais plus de deux générations, et chasse l'ancien cache v11", async () => {
    names.push("cine-app-v11");
    caches.set("cine-app-v11", new FakeCache());
    for (const build of ["aaa", "bbb", "ccc"]) {
      worker(build);
      await activate();
      await get(`/_next/static/chunks/${build}.js`);
    }
    worker("ddd");
    await activate();
    expect(names.filter((n) => n.startsWith("cine-static-"))).toEqual(["cine-static-ccc"]);
    expect(names).not.toContain("cine-app-v11");
  });

  it("laisse les images au cache du navigateur", async () => {
    worker("aaa");
    expect(await get("/_next/image?url=%2Fposter.jpg&w=256&q=75")).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });
});

describe("les onglets d'un code plus ancien (25/09/2026)", () => {
  beforeEach(() => {
    names = [];
    caches = new Map();
    network = vi.fn();
  });

  function tab(visibilityState: "hidden" | "visible") {
    return { visibilityState, url: "https://cine.example/#film=265", navigate: vi.fn().mockResolvedValue(undefined) };
  }

  it("recharge ceux qui sont en arrière-plan, jamais celui qu'on regarde", async () => {
    const hidden = tab("hidden");
    const visible = tab("visible");
    worker("b1");
    const scope = lastScope();
    scope.clients.matchAll.mockResolvedValue([hidden, visible]);
    await activate();
    expect(hidden.navigate).toHaveBeenCalledWith(hidden.url);
    expect(visible.navigate).not.toHaveBeenCalled();
  });

  it("une seule fois par navigateur, et non à chaque déploiement", async () => {
    const hidden = tab("hidden");
    worker("b1");
    lastScope().clients.matchAll.mockResolvedValue([hidden]);
    await activate();
    worker("b2");
    lastScope().clients.matchAll.mockResolvedValue([hidden]);
    await activate();
    expect(hidden.navigate).toHaveBeenCalledTimes(1);
  });
});
