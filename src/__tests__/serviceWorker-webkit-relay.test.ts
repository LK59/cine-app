import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Le relais WebKit du service worker (27/10/2026) : sur WebKit, ce que le worker laisse passer sans
 * répondre n'est jamais relu dans le cache HTTP d'un lancement à l'autre — le catalogue et les images
 * `immutable` repartaient en entier à chaque ouverture d'un iPhone. Les images et trois réponses de
 * l'ouverture y passent donc par `respondWith(fetch(request))`, et seulement là.
 */
type Handler = (event: FakeEvent) => void;
interface FakeEvent {
  request: Request;
  respondWith: (r: Promise<Response> | Response) => void;
}

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0";

let listeners: Record<string, Handler>;
const put = vi.fn().mockResolvedValue(undefined);

function loadWorker(userAgent: string | undefined, fetchImpl: typeof fetch) {
  listeners = {};
  put.mockClear();
  const cache = { put, match: vi.fn().mockResolvedValue(undefined), addAll: vi.fn().mockResolvedValue(undefined) };
  const scope = {
    addEventListener: (type: string, handler: Handler) => {
      listeners[type] = handler;
    },
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
    location: { href: "https://cine.example/sw.js?v=abc" },
    ...(userAgent ? { navigator: { userAgent } } : {}),
  };
  const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", `${source}`)(scope, scope.caches, fetchImpl);
}

function request(url: string, destination = ""): Request {
  const r = new Request(url);
  Object.defineProperty(r, "destination", { value: destination });
  Object.defineProperty(r, "mode", { value: destination === "image" ? "no-cors" : "cors" });
  return r;
}

/** Ce que le worker a fait de la requête : `null` s'il l'a laissée passer sans répondre. */
async function through(r: Request): Promise<Response | null> {
  let answered: Promise<Response> | Response | null = null;
  listeners.fetch({ request: r, respondWith: (x) => (answered = x) });
  return answered ? await answered : null;
}

beforeEach(() => {
  vi.stubGlobal("Response", Response);
  vi.stubGlobal("Request", Request);
});

describe("le relais WebKit du service worker", () => {
  it.each([
    ["une image servie par l'application", "https://cine.example/api/jellyfin/image?itemId=a&tag=b", "image"],
    ["une image TMDB", "https://image.tmdb.org/t/p/w342/a.jpg", "image"],
    ["une image de l'optimiseur", "https://cine.example/_next/image?url=x&w=640&q=75", "image"],
    ["le catalogue des films", "https://cine.example/api/cinema/movies", ""],
    ["le catalogue des séries", "https://cine.example/api/cinema/series", ""],
    ["les nouveautés", "https://cine.example/api/release-notes", ""],
  ])("relaie %s sur Safari, sans rien garder", async (_, url, destination) => {
    const network = vi.fn().mockResolvedValue(new Response("x"));
    loadWorker(SAFARI_IPHONE, network as unknown as typeof fetch);
    const r = request(url, destination);
    const answer = await through(r);
    expect(answer).not.toBeNull();
    // La requête d'origine, telle quelle : ses en-têtes (un If-None-Match posé à la main) suivent.
    expect(network).toHaveBeenCalledWith(r);
    await new Promise((x) => setTimeout(x, 0));
    expect(put).not.toHaveBeenCalled();
  });

  it("ne télécharge qu'une fois une image demandée plusieurs fois à la fois, une copie pour chacune", async () => {
    const network = vi.fn().mockImplementation(async () => new Response("octets"));
    loadWorker(SAFARI_IPHONE, network as unknown as typeof fetch);
    const url = "https://cine.example/_next/image?url=x&w=640&q=75";
    const answers = await Promise.all([1, 2, 3].map(() => through(request(url, "image"))));
    expect(network).toHaveBeenCalledTimes(1);
    expect(await Promise.all(answers.map((a) => a!.text()))).toEqual(["octets", "octets", "octets"]);
  });

  it("redemande après un échec, au lieu de resservir l'échec", async () => {
    const network = vi.fn().mockRejectedValueOnce(new TypeError("réseau")).mockResolvedValue(new Response("x"));
    loadWorker(SAFARI_IPHONE, network as unknown as typeof fetch);
    const url = "https://cine.example/_next/image?url=y&w=640&q=75";
    await expect(through(request(url, "image"))).rejects.toThrow("réseau");
    await new Promise((x) => setTimeout(x, 0));
    expect(await through(request(url, "image"))).not.toBeNull();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("relaie aussi sous Chrome pour iOS, qui est WebKit", async () => {
    const network = vi.fn().mockResolvedValue(new Response("x"));
    loadWorker(CHROME_IOS, network as unknown as typeof fetch);
    expect(await through(request("https://image.tmdb.org/t/p/w342/a.jpg", "image"))).not.toBeNull();
  });

  it.each([
    ["le flux vidéo", "https://cine.example/api/jellyfin/stream/a/stream.mkv?static=true", ""],
    ["une autre route", "https://cine.example/api/jellyfin/resume", ""],
    ["les événements du serveur", "https://cine.example/api/sse", ""],
  ])("laisse passer %s sans y toucher, même sur Safari", async (_, url, destination) => {
    const network = vi.fn().mockResolvedValue(new Response("x"));
    loadWorker(SAFARI_IPHONE, network as unknown as typeof fetch);
    expect(await through(request(url, destination))).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it("garde le code et ses images dans son propre cache, pas dans le relais", async () => {
    const network = vi.fn().mockResolvedValue(new Response("x"));
    loadWorker(SAFARI_IPHONE, network as unknown as typeof fetch);
    await through(request("https://cine.example/_next/static/media/logo.abc.png", "image"));
    await new Promise((x) => setTimeout(x, 0));
    expect(put).toHaveBeenCalled();
  });

  it.each([
    ["Chrome", CHROME_WINDOWS],
    ["Firefox", FIREFOX],
    ["un worker sans agent connu", undefined],
  ])("ne change rien sous %s", async (_, ua) => {
    const network = vi.fn().mockResolvedValue(new Response("x"));
    loadWorker(ua, network as unknown as typeof fetch);
    expect(await through(request("https://cine.example/api/jellyfin/image?itemId=a&tag=b", "image"))).toBeNull();
    expect(await through(request("https://cine.example/api/cinema/movies"))).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });
});
