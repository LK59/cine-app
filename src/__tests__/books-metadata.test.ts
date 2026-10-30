import { describe, it, expect, vi, beforeEach } from "vitest";
import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";

/**
 * Les métadonnées des livres (DECISIONS.md §127). Jellyfin donne à un livre le nom de son dossier pour
 * série : rangée par auteur (`/livres/<Auteur>/…`), une bibliothèque faisait de chaque roman isolé un
 * tome de la « série » de son auteur. La série vient donc de l'EPUB seul (OPF), lue par plages — avec
 * ses auteurs et sa couverture, que Jellyfin n'a pas toujours.
 */
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "laterna-books-meta-"));
});
vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "k" } } }));
const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jellyfinBreaker", () => ({ passJellyfinFetch: (...a: unknown[]) => upstream(...a), jellyfinFetch: (...a: unknown[]) => upstream(...a) }));

import { bookAuthors, bookGenres, decideSeries, nameKey } from "@/lib/books/metadata";
import { EpubDefectError, PLAYING_GAP_MS, knownMeta, parseOpf, readEpubMeta, scheduleMetaReads, staleMeta, __testing } from "@/lib/books/epubMeta";
import { epubCover } from "@/lib/books/covers";
import { authorIndex, filterBooks, homeRows, sortBooks } from "@/lib/books/grouping";
import type { BookSummary } from "@/lib/books/types";

describe("la série à croire : celle de l'EPUB, et elle seule", () => {
  it("l'OPF dit la série", () => {
    expect(decideSeries({ opfSeries: " Cherub " })).toBe("Cherub");
  });
  it("sans série dans l'EPUB, aucune — quel que soit le dossier (auteur, lot, racine)", () => {
    expect(decideSeries({ opfSeries: null })).toBeNull();
    expect(decideSeries({ opfSeries: "" })).toBeNull();
  });
  it("les noms se rapprochent sans ordre ni accents", () => {
    expect(nameKey("Muchamore Robert")).toBe(nameKey("Robert  Muchamore"));
    expect(nameKey("Élodie Durand")).toBe(nameKey("durand elodie"));
  });
});

describe("les genres", () => {
  it("coupés, nettoyés, regroupés sans accents ni casse", () => {
    expect(bookGenres(["Policier/Thriller", "thriller", "eBook", "2014", "Science-fiction; Fantasy", "épouvante", "Epouvante"])).toEqual([
      "Policier",
      "Thriller",
      "Science-fiction",
      "Fantasy",
      "Épouvante",
    ]);
    expect(bookGenres([])).toEqual([]);
  });
  it("les synonymes ramenés à un libellé, les étiquettes et le rayonnage écartés", () => {
    expect(bookGenres(["SF", "Science-Fiction", "science fiction"])).toEqual(["Science-fiction"]);
    expect(bookGenres(["Polar", "Policier", "Thriller"])).toEqual(["Policier", "Thriller"]);
    expect(bookGenres(["Fantasy", "Fantastique"])).toEqual(["Fantasy", "Fantastique"]);
    expect(bookGenres(["Lang:fr", "Fiction", "Roman", "9782266154956", "isbn:978", "http://x"])).toEqual([]);
  });
});

describe("l'OPF", () => {
  it("Calibre (EPUB 2)", () => {
    const opf = `<package><metadata><dc:subject>Aventure</dc:subject><dc:subject>Espionnage</dc:subject>
      <meta name="calibre:series" content="Cherub"/><meta name="calibre:series_index" content="10.0"/></metadata></package>`;
    expect(parseOpf(opf)).toEqual({ series: "Cherub", seriesIndex: 10, subjects: ["Aventure", "Espionnage"], creators: [], coverPath: null });
  });
  it("EPUB 3 : belongs-to-collection et group-position", () => {
    const opf = `<package><metadata><meta property="belongs-to-collection" id="c01">Les Rougon-Macquart</meta>
      <meta refines="#c01" property="collection-type">series</meta><meta refines="#c01" property="group-position">7</meta></metadata></package>`;
    expect(parseOpf(opf)).toEqual({ series: "Les Rougon-Macquart", seriesIndex: 7, subjects: [], creators: [], coverPath: null });
  });
  it("une apostrophe dans une valeur entre guillemets doubles n'y met pas fin (29/10/2026 : « Ailes d »)", () => {
    const opf = `<package><metadata><meta name="calibre:series" content="Les ailes d'Alexanne"/><meta name="calibre:series_index" content="2"/></metadata></package>`;
    expect(parseOpf(opf)).toMatchObject({ series: "Les ailes d'Alexanne", seriesIndex: 2 });
    expect(parseOpf(`<package><metadata><meta name='calibre:series' content='Le "Cycle"'/></metadata></package>`).series).toBe('Le "Cycle"');
  });

  it("sans série : rien, pas même un rang", () => {
    expect(parseOpf(`<package><metadata><meta name="calibre:series_index" content="8.5"/></metadata></package>`)).toEqual({ series: null, seriesIndex: null, subjects: [], creators: [], coverPath: null });
  });
  it("les auteurs (dc:creator, rôle « aut » ou sans rôle) et la couverture, EPUB 2 ou 3", () => {
    const epub2 = `<package><metadata><dc:creator opf:role="aut">Vargas, Fred</dc:creator><dc:creator opf:role="ill">Un illustrateur</dc:creator>
      <meta name="cover" content="img-c"/></metadata><manifest><item id="img-c" href="../Images/couv%201.jpg" media-type="image/jpeg"/></manifest></package>`;
    expect(parseOpf(epub2, "OEBPS/Text/content.opf")).toMatchObject({ creators: ["Vargas, Fred"], coverPath: "OEBPS/Images/couv 1.jpg" });
    const epub3 = `<package><metadata><dc:creator>Guillaume Musso</dc:creator></metadata><manifest>
      <item id="x" href="cover.png" media-type="image/png" properties="cover-image"/></manifest></package>`;
    expect(parseOpf(epub3, "content.opf")).toMatchObject({ creators: ["Guillaume Musso"], coverPath: "cover.png" });
  });
});

describe("les auteurs à afficher", () => {
  it("ceux de Jellyfin d'abord, sinon ceux de l'OPF, « Nom, Prénom » remis dans l'ordre", () => {
    expect(bookAuthors(["Fred Vargas"], ["Autre"])).toEqual(["Fred Vargas"]);
    expect(bookAuthors([], ["Vargas, Fred"])).toEqual(["Fred Vargas"]);
    expect(bookAuthors([], undefined)).toEqual([]);
  });
});

/** Un petit zip écrit à la main : de quoi éprouver la lecture par plages de bout en bout. */
function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

let served = 0;
function serve(file: Buffer) {
  served = 0;
  upstream.mockImplementation(async (_url: string, init: RequestInit) => {
    const r = /bytes=(-?\d+)-?(\d*)/.exec(new Headers(init.headers).get("range") ?? "");
    let start = Number(r?.[1] ?? 0);
    let end = r?.[2] ? Number(r[2]) : file.length - 1;
    if (start < 0) {
      start = Math.max(0, file.length + start);
      end = file.length - 1;
    }
    end = Math.min(end, file.length - 1);
    served += end - start + 1;
    return new Response(new Uint8Array(file.subarray(start, end + 1)), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.length}` } });
  });
}

const EPUB = zip({
  mimetype: "application/epub+zip",
  "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
  // Incompressible : le chapitre pèse vraiment ses 400 Ko dans le zip.
  "OEBPS/chapitre.xhtml": randomBytes(300_000).toString("base64"),
  "OEBPS/content.opf": `<package><metadata><meta name="calibre:series" content="Cherub"/><meta name="calibre:series_index" content="3"/><dc:subject>Espionnage</dc:subject></metadata></package>`,
});

describe("la lecture de l'OPF par plages", () => {
  beforeEach(() => vi.clearAllMocks());
  it("lit la série sans télécharger le livre", async () => {
    serve(EPUB);
    expect(await readEpubMeta("a".repeat(32))).toEqual({ series: "Cherub", seriesIndex: 3, subjects: ["Espionnage"], creators: [], coverPath: null });
    // La fin, le conteneur, l'OPF : bien moins que le livre, dont le chapitre pèse 400 Ko.
    expect(served).toBeLessThan(EPUB.length / 3);
  });
  it("une fois par fichier : gardé avec son empreinte, relu quand elle change", async () => {
    serve(EPUB);
    const id = "b".repeat(32);
    scheduleMetaReads([{ id, etag: "e1" }]);
    await vi.waitFor(() => expect(knownMeta().get(id)?.meta?.series).toBe("Cherub"));
    expect(__testing.queue().running).toBe(0);
    const known = knownMeta();
    expect(staleMeta([{ id, etag: "e1" }], known)).toEqual([]);
    expect(staleMeta([{ id, etag: "e2" }], known)).toEqual([{ id, etag: "e2" }]);
  });
  it("pendant un film, un livre à la fois et un par seconde ; sinon deux à la fois ; écrites par lots", async () => {
    const q = __testing.queue();
    const realReader = q.reader;
    const realPlaying = q.playing;
    let playing = true;
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const read = vi.fn(async () => {
      starts.push(Date.now());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { series: null, seriesIndex: null, subjects: [], creators: [], coverPath: null };
    });
    q.reader = read;
    q.playing = () => playing;
    q.lastStart = 0;
    try {
      const items = Array.from({ length: 60 }, (_, i) => ({ id: (i + 1).toString(16).padStart(32, "f"), etag: "e" }));
      const version = q.version;
      scheduleMetaReads(items);
      // Un film joue : la file avance quand même, mais doucement.
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
      expect(maxInFlight).toBe(1);
      for (let i = 1; i < 3; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(PLAYING_GAP_MS - 20);
      playing = false;
      await vi.waitFor(() => expect(knownMeta().get(items[59].id)).toBeDefined(), { timeout: 8000 });
      expect(read).toHaveBeenCalledTimes(60);
      expect(maxInFlight).toBeLessThanOrEqual(2);
      // Soixante lectures, quelques transactions seulement.
      expect(q.version - version).toBeLessThanOrEqual(8);
    } finally {
      q.reader = realReader;
      q.playing = realPlaying;
    }
  });
});

describe("la couverture tirée de l'EPUB", () => {
  beforeEach(() => vi.clearAllMocks());
  it("réduite en WebP, gardée sur le disque, jamais refaite ; un EPUB sans couverture ne l'est jamais non plus", async () => {
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 900, height: 1350, channels: 3, background: "#336699" } }).png().toBuffer();
    const withCover = zip({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      "OEBPS/content.opf": `<package><metadata><meta name="cover" content="c"/></metadata><manifest><item id="c" href="img/cover.png" media-type="image/png"/></manifest></package>`,
      "OEBPS/img/cover.png": png,
    });
    serve(withCover);
    const id = "c".repeat(32);
    const out = await epubCover(id, "etag-1");
    expect(out).not.toBeNull();
    const info = await sharp(out as Buffer).metadata();
    expect(info.format).toBe("webp");
    expect(info.width).toBe(360);
    const calls = upstream.mock.calls.length;
    expect(await epubCover(id, "etag-1")).toEqual(out);
    expect(upstream.mock.calls.length).toBe(calls);

    serve(EPUB);
    const bare = "d".repeat(32);
    expect(await epubCover(bare, "etag-1")).toBeNull();
    const after = upstream.mock.calls.length;
    expect(await epubCover(bare, "etag-1")).toBeNull();
    expect(upstream.mock.calls.length).toBe(after);
  });
});

const book = (over: Partial<BookSummary>): BookSummary => ({
  id: Math.random().toString(16).slice(2).padEnd(32, "0"),
  name: "x",
  coverTag: null,
  fileTag: null,
  seriesName: null,
  index: null,
  year: null,
  authors: [],
  genres: [],
  addedAt: null,
  played: false,
  progress: null,
  ...over,
});

describe("les rangées d'une bibliothèque rangée par auteur", () => {
  const books = [
    book({ name: "Central Park", authors: ["Guillaume Musso"], year: 2014, genres: ["Thriller"] }),
    book({ name: "La jeune fille et la nuit", authors: ["Guillaume Musso"], year: 2018, genres: ["Thriller"] }),
    book({ name: "L'appel de l'ange", authors: ["Guillaume Musso"], year: 2011, genres: ["Romance"] }),
    book({ name: "Arizona Max", authors: ["Robert Muchamore"], seriesName: "Cherub", index: 3, genres: ["Thriller"] }),
    book({ name: "100 jours en enfer", authors: ["Muchamore Robert"], seriesName: "Cherub", index: 1 }),
    book({ name: "L'homme à l'envers", authors: ["Fred Vargas"], year: 1999 }),
  ];
  it("une série (deux livres et plus), un auteur (par année), un genre (trois livres et plus)", () => {
    const { rows } = homeRows(books);
    expect(rows.map((r) => [r.kind, r.title, r.books.length])).toEqual([
      ["series", "Cherub", 2],
      ["author", "Guillaume Musso", 3],
      ["genre", "Thriller", 3],
    ]);
    // Par année, du plus ancien au plus récent.
    expect(rows[1].books.map((b) => b.year)).toEqual([2011, 2014, 2018]);
  });
  it("un auteur dont tous les livres sont dans une même série montrée n'a pas de rangée en double", () => {
    expect(homeRows(books).rows.some((r) => r.kind === "author" && r.title.includes("Muchamore"))).toBe(false);
  });
  it("« Muchamore Robert » et « Robert Muchamore » sont un seul auteur, filtrable sous l'une ou l'autre forme", () => {
    expect([...authorIndex(books).values()].filter((a) => /muchamore/i.test(a.label))).toHaveLength(1);
    expect(filterBooks(books, { auteur: "Muchamore Robert" })).toHaveLength(2);
    expect(filterBooks(books, { genre: "thriller" })).toHaveLength(3);
  });
  it("les tris de la grille", () => {
    expect(sortBooks(books, "year")[0].year).toBe(2018);
    expect(sortBooks(books, "title")[0].name).toBe("100 jours en enfer");
    expect(sortBooks(books, "author")[0].authors[0]).toBe("Robert Muchamore");
  });
});

describe("une bibliothèque à deux racines, dont un lot de milliers d'EPUB", () => {
  beforeEach(() => vi.clearAllMocks());
  it("le dossier du lot n'est jamais une série ; l'auteur vient des métadonnées, pas du dossier", async () => {
    const { bookIndex } = await import("@/lib/books/bookIndex");
    upstream.mockImplementation(async (url: string) => {
      if (url.endsWith("/Library/VirtualFolders")) return new Response(JSON.stringify([{ ItemId: "l".repeat(32), CollectionType: "books" }]), { status: 200 });
      if (!url.includes("IncludeItemTypes")) return new Response("{}", { status: 200 });
      const items = [
        { Id: "1".repeat(32), Name: "Central Park", Type: "Book", SeriesName: "6000 Romans Ebook en Epub Pack", People: [{ Name: "Guillaume Musso", Type: "Author" }] },
        { Id: "2".repeat(32), Name: "L'appel de l'ange", Type: "Book", SeriesName: "Guillaume Musso", IndexNumber: 3, People: [{ Name: "Guillaume Musso", Type: "Author" }] },
      ];
      return new Response(JSON.stringify({ Items: items, TotalRecordCount: 2 }), { status: 200 });
    });
    const { books } = await bookIndex({ role: "user", jfId: "c".repeat(32) });
    expect(books.map((b: BookSummary) => [b.name, b.seriesName, b.index, b.authors])).toEqual([
      ["Central Park", null, null, ["Guillaume Musso"]],
      ["L'appel de l'ange", null, null, ["Guillaume Musso"]],
    ]);
  });
  it("un même livre dans les deux racines : une fois dans les rangées, deux fois dans la grille", () => {
    const lu = book({ name: "Central Park", authors: ["Guillaume Musso"], addedAt: 1, progress: { cfi: "epubcfi(/6/2)", fraction: 0.4, updatedAt: 3, finished: false } });
    const copie = book({ name: "CENTRAL PARK", authors: ["Musso Guillaume"], addedAt: 2, coverTag: "t", genres: ["Thriller"] });
    const autre = book({ name: "La jeune fille et la nuit", authors: ["Guillaume Musso"], addedAt: 0 });
    const { recent, rows, resume } = homeRows([lu, copie, autre]);
    // Celui où l'on a lu l'emporte sur la copie mieux décrite.
    expect(recent.map((b) => b.id)).toEqual([lu.id, autre.id]);
    expect(resume.map((b) => b.id)).toEqual([lu.id]);
    expect(rows.find((r) => r.kind === "author")?.books).toHaveLength(2);
    expect(filterBooks([lu, copie, autre], "central")).toHaveLength(2);
  });
});

describe("la langue d'un livre, pour Google Books", () => {
  it("celle de l'EPUB d'abord, sinon celle des métadonnées de sa bibliothèque Jellyfin", async () => {
    const { enrichTargets, __testing: indexTesting } = await import("@/lib/books/bookIndex");
    indexTesting.reset();
    const db = (await import("@/lib/db")).getDb();
    db.prepare("DELETE FROM book_meta").run();
    // L'EPUB du premier déclare l'allemand ; le second n'en dit rien.
    db.prepare("INSERT INTO book_meta (item_id, etag, series, series_index, subjects, creators, cover_path, language, failed, checked_at) VALUES (?, 'e', NULL, NULL, '[]', '[]', NULL, 'de', 0, 1)").run("5".repeat(32));
    upstream.mockImplementation(async (url: string) => {
      if (url.endsWith("/Library/VirtualFolders"))
        return new Response(JSON.stringify([{ ItemId: "l".repeat(32), CollectionType: "books", LibraryOptions: { PreferredMetadataLanguage: "en-US" } }]), { status: 200 });
      if (!url.includes("ParentId")) return new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 });
      const items = [
        { Id: "5".repeat(32), Name: "Der Vorleser", Type: "Book", People: [{ Name: "Bernhard Schlink", Type: "Author" }] },
        { Id: "6".repeat(32), Name: "Lunatic Cafe", Type: "Book", People: [{ Name: "Laurell K. Hamilton", Type: "Author" }] },
      ];
      return new Response(JSON.stringify({ Items: items, TotalRecordCount: 2 }), { status: 200 });
    });
    const targets = await enrichTargets();
    expect(Object.fromEntries(targets.map((t) => [t.name, t.language]))).toEqual({ "Der Vorleser": "de", "Lunatic Cafe": "en" });
    indexTesting.reset();
  });
});

describe("un EPUB illisible est masqué, pas supprimé", () => {
  beforeEach(() => vi.clearAllMocks());
  it("un zip tronqué est un défaut du fichier ; une panne de Jellyfin n'en est pas un", async () => {
    // Un lot en cours de partage contenait des EPUB tronqués : « zip sans fin de répertoire ».
    serve(EPUB.subarray(0, EPUB.length - 200));
    await expect(readEpubMeta("c".repeat(32))).rejects.toBeInstanceOf(EpubDefectError);
    const broken = "d".repeat(32);
    scheduleMetaReads([{ id: broken, etag: "e1" }]);
    await vi.waitFor(() => expect(knownMeta().get(broken)?.defect).toBe(true));
    upstream.mockImplementation(async () => new Response("", { status: 503 }));
    const down = "e".repeat(32);
    scheduleMetaReads([{ id: down, etag: "e1" }]);
    await vi.waitFor(() => expect(knownMeta().get(down)?.failed).toBe(true));
    expect(knownMeta().get(down)?.defect).toBe(false);
    // Le défaut n'est relu qu'au bout d'une semaine, ou dès que le fichier change ; la panne, le lendemain.
    const known = knownMeta();
    const day = 24 * 3600_000;
    expect(staleMeta([{ id: broken, etag: "e1" }], known, Date.now() + 2 * day)).toEqual([]);
    expect(staleMeta([{ id: broken, etag: "e1" }], known, Date.now() + 8 * day)).toHaveLength(1);
    expect(staleMeta([{ id: broken, etag: "e2" }], known)).toHaveLength(1);
    expect(staleMeta([{ id: down, etag: "e1" }], known, Date.now() + 2 * day)).toHaveLength(1);
  });
  it("l'index ne montre pas un fichier illisible — remplacé, il revient ; un échec passager reste montré", async () => {
    const { enrichTargets, __testing: indexTesting } = await import("@/lib/books/bookIndex");
    indexTesting.reset();
    const db = (await import("@/lib/db")).getDb();
    db.prepare("DELETE FROM book_meta").run();
    const row = db.prepare("INSERT INTO book_meta (item_id, etag, series, series_index, subjects, creators, cover_path, language, failed, checked_at) VALUES (?, ?, NULL, NULL, '[]', '[]', NULL, NULL, ?, ?)");
    const now = Date.now();
    row.run("7".repeat(32), "abime", 2, now);
    row.run("8".repeat(32), "ancien", 2, now);
    row.run("9".repeat(32), "e", 1, now);
    upstream.mockImplementation(async (url: string) => {
      if (url.endsWith("/Library/VirtualFolders")) return new Response(JSON.stringify([{ ItemId: "l".repeat(32), CollectionType: "books" }]), { status: 200 });
      if (!url.includes("ParentId")) return new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 });
      const items = [
        { Id: "7".repeat(32), Etag: "abime", Name: "Dôme 2", Type: "Book" },
        { Id: "8".repeat(32), Etag: "remplace", Name: "Neuromancien", Type: "Book" },
        { Id: "9".repeat(32), Etag: "e", Name: "Le Singe", Type: "Book" },
      ];
      return new Response(JSON.stringify({ Items: items, TotalRecordCount: 3 }), { status: 200 });
    });
    const names = (await enrichTargets()).map((t) => t.name).sort();
    expect(names).toEqual(["Le Singe", "Neuromancien"]);
    indexTesting.reset();
  });
});
