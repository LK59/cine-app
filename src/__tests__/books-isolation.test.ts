import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NextRequest } from "next/server";

// Une base à soi (« Afficher les livres » y est écrit) : la base du dossier commun est ouverte par
// d'autres fichiers en même temps, et une écriture de plus y provoquait des « database is locked ».
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-books-isolation-"));
});

/**
 * L'option « Livres » (DECISIONS.md §127) coupée ne change rien, et ne s'ouvre jamais à un lien de
 * partage. Ce que ce fichier prouve :
 *
 * - coupée par défaut, dans le schéma et dans `config` ;
 * - la page `/livres` n'existe pas tant qu'elle est coupée ;
 * - la configuration publique ne l'annonce pas, et jamais à une session de partage ;
 * - une session de partage n'atteint aucune route des livres, ni la page (liste fermée, §112) ;
 * - l'accueil ne charge du code des livres que l'entrée, qui ne contient rien d'autre ;
 * - la politique de sécurité générale n'est pas élargie.
 */

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const shares = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/lib/share/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/share/store")>();
  return { ...real, sharesDb: { get: () => shares.current, jellyfinUserIds: () => new Set<string>() } };
});

const BOOK = "a".repeat(32);
const EXPIRES = Date.now() + 86_400_000;
const SHARE = {
  id: "0123456789abcdef",
  code: "abcdefghjk",
  kind: "movie",
  itemId: BOOK,
  radarrId: 12,
  sonarrId: null,
  expiresAt: EXPIRES,
  revokedAt: null,
  maxStreams: 3,
  jfUserId: "f".repeat(32),
  jfUserName: "partage-01234567",
  jfDeletedAt: null,
};

function req(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BOOKS_ENABLED;
  delete process.env.BOOKS_REQUESTS_ENABLED;
  shares.current = SHARE;
});

describe("coupée par défaut", () => {
  it("le schéma la déclare réglable dans l'application, coupée", async () => {
    const { SETTINGS_BY_KEY } = await import("@/lib/settings/schema");
    expect(SETTINGS_BY_KEY.get("BOOKS_ENABLED")).toMatchObject({ kind: "boolean", inApp: true, fallback: "false", group: "playback" });
    expect(SETTINGS_BY_KEY.get("BOOKS_REQUESTS_ENABLED")).toMatchObject({ kind: "boolean", inApp: true, fallback: "false", group: "playback" });
  });
  it("sans réglage ni `.env`, `config.books.enabled` est faux ; `.env` l'allume, relu à chaque accès", async () => {
    const { config } = await import("@/lib/config");
    expect(config.books.enabled).toBe(false);
    process.env.BOOKS_ENABLED = "true";
    expect(config.books.enabled).toBe(true);
    delete process.env.BOOKS_ENABLED;
    expect(config.books.enabled).toBe(false);
  });
  it("l'interrupteur a son libellé dans les quatre langues", () => {
    for (const lang of ["fr", "en", "es", "de"]) {
      const dict = JSON.parse(read(`src/locales/${lang}.json`));
      expect(typeof dict.setup.fields.BOOKS_ENABLED, lang).toBe("string");
    }
  });
});

describe("la page /livres", () => {
  it("n'existe pas tant que l'option est coupée", async () => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`REDIRECT ${to}`);
      },
    }));
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
    vi.doMock("@/components/books/BooksScreenLazy", () => ({ BooksScreenLazy: () => null }));
    mockVerify.mockResolvedValue({ u: "lecteur", role: "user", jfId: "x", jti: "j" });
    const { default: BooksPage } = await import("@/app/livres/page");
    await expect(BooksPage()).rejects.toThrow("NEXT_NOT_FOUND");
    // Coupée, la session n'est même pas lue.
    expect(mockVerify).not.toHaveBeenCalled();
    process.env.BOOKS_ENABLED = "true";
    await expect(BooksPage()).resolves.toBeTruthy();
    mockVerify.mockResolvedValue({ u: "partage", role: "share", sh: "s", jti: "j" });
    await expect(BooksPage()).rejects.toThrow("REDIRECT /");
    vi.doUnmock("next/navigation");
    vi.doUnmock("next/headers");
    vi.doUnmock("@/components/books/BooksScreenLazy");
  });
  it("la page hors ligne des livres : publique (le service worker la demande sans cookie), absente option coupée", async () => {
    const { isPublicPath } = await import("@/lib/publicPaths");
    expect(isPublicPath("/livres/hors-ligne")).toBe(true);
    // La page des livres elle-même reste derrière la session.
    expect(isPublicPath("/livres")).toBe(false);
    vi.resetModules();
    delete process.env.BOOKS_ENABLED;
    vi.doMock("next/navigation", () => ({
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
    }));
    vi.doMock("@/components/books/OfflineBooksScreenLazy", () => ({ OfflineBooksScreenLazy: () => null }));
    const { default: OfflinePage } = await import("@/app/livres/hors-ligne/page");
    expect(() => OfflinePage()).toThrow("NEXT_NOT_FOUND");
    process.env.BOOKS_ENABLED = "true";
    expect(OfflinePage()).toBeTruthy();
    vi.doUnmock("next/navigation");
    vi.doUnmock("@/components/books/OfflineBooksScreenLazy");
  });
});

describe("la configuration publique", () => {
  it("n'annonce les livres qu'allumés, et jamais à une session de partage", async () => {
    vi.resetModules();
    const { GET } = await import("@/app/api/config/public/route");
    const call = async () => (await GET({ cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest)).json();
    mockVerify.mockResolvedValue({ u: "lecteur", role: "user", jfId: "x", jti: "j" });
    expect((await call()).booksEnabled).toBe(false);
    process.env.BOOKS_ENABLED = "true";
    expect((await call()).booksEnabled).toBe(true);
    // Les demandes : coupées par défaut, ouvertes seulement avec les livres.
    expect((await call()).bookRequests).toBe(false);
    process.env.BOOKS_REQUESTS_ENABLED = "true";
    expect((await call()).bookRequests).toBe(true);
    // « Afficher les livres » coupé pour ce compte : ni la catégorie, ni les demandes — mais le réglage
    // reste offert dans le Compte, pour le rallumer.
    const { userPrefsDb } = await import("@/lib/db");
    userPrefsDb.setShowBooks("x", false);
    expect(await call()).toMatchObject({ booksEnabled: false, bookRequests: false, booksAvailable: true });
    userPrefsDb.setShowBooks("x", true);
    expect(await call()).toMatchObject({ booksEnabled: true, booksAvailable: true });
    mockVerify.mockResolvedValue({ u: "partage", role: "share", sh: "s", jti: "j" });
    expect(await call()).toMatchObject({ booksEnabled: false, booksAvailable: false });
  });
});

describe("une session de partage", () => {
  it("n'a aucune règle pour les routes des livres", async () => {
    const { shareRuleFor } = await import("@/lib/share/gate");
    for (const [method, p] of [
      ["GET", "/api/books"],
      ["GET", `/api/books/${BOOK}`],
      ["GET", `/api/books/${BOOK}/file`],
      ["GET", `/api/books/${BOOK}/progress`],
      ["POST", `/api/books/${BOOK}/progress`],
      ["GET", "/api/books/requests"],
      ["POST", "/api/books/requests"],
      ["PATCH", "/api/books/requests/1"],
      ["POST", `/api/books/${BOOK}/bookmarks`],
    ]) {
      expect(shareRuleFor(method, p), `${method} ${p}`).toBeNull();
    }
  });
  it("le proxy les refuse — même le livre qui serait l'élément du lien — et renvoie la page à la fiche du lien", async () => {
    process.env.BOOKS_ENABLED = "true";
    mockVerify.mockResolvedValue({ u: "partage-01234567", role: "share", sh: SHARE.id, jti: "j", exp: EXPIRES });
    const { proxy } = await import("@/proxy");
    for (const [method, p] of [
      ["GET", "/api/books"],
      ["GET", `/api/books/${BOOK}`],
      ["GET", `/api/books/${BOOK}/file`],
      ["POST", `/api/books/${BOOK}/progress`],
      ["GET", "/api/books/requests"],
      ["POST", "/api/books/requests"],
      ["PATCH", "/api/books/requests/1"],
    ]) {
      expect((await proxy(req(method, p))).status, `${method} ${p}`).toBe(403);
    }
    const page = await proxy(req("GET", "/livres"));
    expect(page.headers.get("location")).toContain("/partage/abcdefghjk");
  });
  it("un compte du foyer peut écrire sa position et ses signets, et rien d'autre sous /api/books", async () => {
    mockVerify.mockResolvedValue({ u: "lecteur", role: "user", jfId: "x", jti: "j", exp: EXPIRES });
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("POST", `/api/books/${BOOK}/progress`))).status).toBe(200);
    expect((await proxy(req("POST", `/api/books/${BOOK}/bookmarks`))).status).toBe(200);
    expect((await proxy(req("DELETE", `/api/books/${BOOK}/bookmarks`))).status).toBe(403);
    expect((await proxy(req("POST", `/api/books/${BOOK}/file`))).status).toBe(403);
    expect((await proxy(req("DELETE", `/api/books/${BOOK}/progress`))).status).toBe(403);
    // Demander un livre : la demande, oui ; y répondre, non.
    expect((await proxy(req("POST", "/api/books/requests"))).status).toBe(200);
    expect((await proxy(req("PATCH", "/api/books/requests/1"))).status).toBe(403);
  });
});

describe("l'accueil ne charge rien des livres", () => {
  const BOOK_IMPORT = /from\s+["']@\/(components|lib)\/books\/([^"']+)["']|import\(\s*["']([^"']*books[^"']*)["']\s*\)/g;

  it("les deux écrans du cinéma et la recherche n'importent des livres que `BooksMode`", () => {
    for (const file of ["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx", "src/components/player/PlayerSearchPanel.tsx", "src/components/offline/OfflineDownloadsView.tsx"]) {
      const found = [...read(file).matchAll(BOOK_IMPORT)].map((m) => m[0]);
      expect(found, file).toEqual([`from "@/components/books/BooksMode"`]);
    }
  });
  it("`BooksMode` ne contient rien des livres : l'accueil des livres n'est chargé que dans leur catégorie", () => {
    const mode = read("src/components/books/BooksMode.tsx");
    const staticImports = [...mode.matchAll(/^import .* from ["']([^"']+)["'];$/gm)].map((m) => m[1]);
    expect(staticImports.sort()).toEqual(["@/components/TranslationProvider", "@/lib/cinemaRoute", "@/lib/swr", "lucide-react", "next/dynamic", "react", "swr"]);
    expect(mode).toMatch(/dynamic\(\(\) => import\("\.\/BooksHome"\)/);
    expect(mode).toMatch(/dynamic\(\(\) => import\("\.\/BooksSearch"\)/);
    expect(mode).toMatch(/dynamic\(\(\) => import\("\.\/BooksDownloads"\)/);
    // Rendu seulement quand la catégorie est affichée, donc l'option allumée.
    for (const file of ["src/components/cinema/CinemaClient.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx"]) {
      expect(read(file), file).toMatch(/\{books\.active && <BooksHomeLazy variant="(desktop|mobile)" \/>\}/);
    }
  });
  it("foliate-js n'est chargé que par le lecteur, et le lecteur seulement à l'ouverture d'un livre", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!full.includes(`books${path.sep}foliate`) && !full.includes("__tests__")) walk(full);
        } else if (/\.tsx?$/.test(entry.name) && /books\/foliate\/view(\.js)?["']/.test(fs.readFileSync(full, "utf8"))) users.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.join(process.cwd(), "src"));
    // Les types (`import type`) ne chargent rien ; le seul import réel est dynamique, dans le lecteur.
    const reader = read("src/components/books/BookReader.tsx");
    expect(reader).toMatch(/import\("@\/lib\/books\/foliate\/view\.js"\)/);
    for (const file of users.filter((f) => !f.endsWith("BookReader.tsx"))) {
      for (const line of read(file).split("\n").filter((l) => /books\/foliate\/view/.test(l))) expect(line, file).toMatch(/^import type /);
    }
    expect(read("src/components/books/BooksScreen.tsx")).toMatch(/dynamic\(\(\) => import\("\.\/BookReader"\)/);
  });
  it("rien des livres au lancement : ni requête partie avec la page, ni cache gardé sur l'appareil, ni préchauffage du serveur", () => {
    for (const file of ["src/lib/earlyFetch.ts", "src/lib/persistentCache.ts", "src/lib/catalogueWarm.ts", "src/lib/selfWarm.ts"]) {
      if (fs.existsSync(path.join(process.cwd(), file))) expect(read(file), file).not.toMatch(/books|livres|\/api\/book/i);
    }
    // Le démarrage ne nomme les livres qu'en un endroit : le préchauffage de leur index, importé et
    // lancé seulement l'option allumée (`books-warm.test.ts` éprouve qu'il ne fait rien sinon).
    const boot = read("src/instrumentation.ts");
    const code = boot.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code.match(/books/g)).toHaveLength(2);
    expect(code).toMatch(/if \(config\.books\?\.enabled === true\) \{\s*const \{ startBooksPrewarm \} = await import\("\.\/lib\/books\/prewarm"\);\s*startBooksPrewarm\(\);\s*\}/);
  });
  it("le cache gardé sur l'appareil n'est pas touché ; l'adresse du cinéma ne gagne que des champs facultatifs", () => {
    expect(read("src/lib/persistentCache.ts")).not.toMatch(/book|livre/i);
    // `tab` reste films ou séries : les livres sont un mode à part (`books`, `#livres=1`).
    const route = read("src/lib/cinemaRoute.ts");
    expect(route).toMatch(/tab: "movies" \| "series";/);
    // Trois champs facultatifs, absents de la route tant que l'adresse ne les nomme pas (`books-sheet.test.tsx`).
    expect(route).toMatch(/\bbooks\?: boolean;/);
    expect(route).toMatch(/\bbook\?: string \| null;/);
    expect(route).toMatch(/\breading\?: boolean;/);
  });
});

describe("la politique de sécurité", () => {
  it("la générale garde ses cadres YouTube seuls ; celle des livres permet `blob:` et rien d'extérieur", async () => {
    // Par son chemin : le fichier est du JavaScript sans types, que la vérification de `next build` refuserait importé en clair.
    const configUrl = pathToFileURL(path.join(process.cwd(), "next.config.js")).href;
    const nextConfig = (await import(/* @vite-ignore */ configUrl)).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const rules = await nextConfig.headers();
    const csp = (source: string) => rules.find((r) => r.source === source)?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    const general = csp("/(.*)");
    expect(general).toMatch(/frame-src https:\/\/www\.youtube-nocookie\.com(;|$)/);
    expect(general).not.toMatch(/frame-src[^;]*blob:/);
    const books = csp("/livres");
    expect(books).toMatch(/frame-src blob:(;|$)/);
    expect(books).not.toMatch(/https?:\/\//);
    expect(books).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/);
    expect(books).toMatch(/object-src 'none'/);
    // La règle des livres vient après la générale : la dernière qui pose l'en-tête l'emporte.
    expect(rules.findIndex((r) => r.source === "/livres")).toBeGreaterThan(rules.findIndex((r) => r.source === "/(.*)"));
    // La page hors ligne des livres ouvre le même lecteur : la même politique.
    expect(csp("/livres/hors-ligne")).toBe(books);
    expect(rules.findIndex((r) => r.source === "/livres/hors-ligne")).toBeGreaterThan(rules.findIndex((r) => r.source === "/(.*)"));
  });
});
