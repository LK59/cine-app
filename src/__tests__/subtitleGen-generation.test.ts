import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  FALLBACK_FILE_AFTER_MS,
  isGeneratingTrack,
  POLL_MS,
  SLOW_POLL_MS,
  SubtitleGeneration,
} from "@/lib/subtitleGen/generation";
import { isExternalTrack } from "@/lib/webcodecs/externalSubtitles";

/**
 * « Générer des sous-titres », côté lecteur natif (DECISIONS.md §70) : le sondage, les lignes tenues
 * en mémoire, les messages d'état, la bascule vers la piste finale et les refus — sans navigateur,
 * contre un faux serveur qui suit le contrat.
 */

type Json = Record<string, unknown>;

const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError("pas de JSON");
    return body;
  },
});

function fakeServer() {
  const s = {
    options: { enabled: true, targets: ["fr", "en", "de"], existing: ["en"], jobs: [] as Json[], quota: { used: 0, limit: 30 } } as Json,
    create: { status: 200, body: { jobId: "j1", status: "preparing" } as unknown },
    /** Les réponses du sondage, dans l'ordre ; la dernière se répète. */
    polls: [] as Json[],
    pollBodies: [] as Json[],
    externals: [] as Json[],
    directCalls: 0,
    resumed: [] as string[],
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/subtitle-gen/options")) return answer(200, s.options);
    if (url === "/api/subtitle-gen/jobs") return answer(s.create.status, s.create.body);
    const poll = /^\/api\/subtitle-gen\/jobs\/([^/]+)\/poll$/.exec(url);
    if (poll) {
      s.pollBodies.push({ jobId: poll[1], ...(JSON.parse(String(init?.body)) as Json) });
      const next = s.polls.length > 1 ? s.polls.shift()! : s.polls[0];
      return answer(200, next ?? { status: "running", rev: 0, done: 0, total: 0, cues: [] });
    }
    const resume = /^\/api\/subtitle-gen\/jobs\/([^/]+)\/resume$/.exec(url);
    if (resume) {
      s.resumed.push(resume[1]);
      return answer(204);
    }
    if (url.startsWith("/api/jellyfin/direct/")) {
      s.directCalls += 1;
      return answer(200, { externalSubtitles: s.externals });
    }
    return answer(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return s;
}

let visible = true;
let position = 0;

function make() {
  const log = vi.fn();
  const onError = vi.fn();
  const onFinal = vi.fn();
  const onFailed = vi.fn();
  const generation = new SubtitleGeneration({
    itemId: "item-1",
    sessionId: "sess",
    position: () => position,
    log,
    onError,
    onFinal,
    onFailed,
    visible: () => visible,
  });
  return { generation, log, onError, onFinal, onFailed };
}

const events = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(([fields]) => (fields as Json).event);

beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  position = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("les numéros des entrées temporaires", () => {
  it("ne se confondent ni avec une piste du fichier ni avec un fichier à côté, et restent hors du pipeline", () => {
    expect(isGeneratingTrack(-1_000_000)).toBe(true);
    expect(isGeneratingTrack(-1)).toBe(false);
    expect(isGeneratingTrack(-40)).toBe(false);
    expect(isGeneratingTrack(5)).toBe(false);
    expect(isGeneratingTrack(null)).toBe(false);
    // Négatifs : le pipeline ne les reçoit jamais (`isExternalTrack`).
    expect(isExternalTrack(-1_000_000)).toBe(true);
  });
});

describe("ouvrir", () => {
  it("lit les options et les générations en cours, sans celles qui ont échoué", async () => {
    const s = fakeServer();
    s.options.jobs = [
      { jobId: "j1", target: "fr", status: "running", done: 4, total: 10 },
      { jobId: "j0", target: "de", status: "failed", done: 0, total: 0 },
    ];
    const { generation } = make();
    await generation.open();
    const snap = generation.snapshot();
    expect(snap.options).toMatchObject({ enabled: true, targets: ["fr", "en", "de"] });
    expect(snap.jobs.map((j) => [j.target, j.status, j.done, j.total])).toEqual([["fr", "running", 4, 10]]);
    // Rien n'est sondé tant que le spectateur n'a pas choisi la piste.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.pollBodies).toHaveLength(0);
    generation.close();
  });

  it("un serveur sans ces routes ne propose rien et ne dit rien", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(404)));
    const { generation, onError } = make();
    await generation.open();
    expect(generation.snapshot().options?.enabled).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("générer", () => {
  it("demande avec la position, active l'entrée et sonde toutes les deux secondes avec la position courante", async () => {
    const s = fakeServer();
    const { generation, log } = make();
    await generation.open();
    position = 125.4;
    const id = await generation.generate("fr");
    expect(isGeneratingTrack(id)).toBe(true);
    expect(generation.activeTarget).toBe("fr");
    expect(generation.snapshot().jobs[0]).toMatchObject({ jobId: "j1", target: "fr", status: "preparing", id });
    expect(events(log)).toEqual(["demande", "activation"]);
    expect(log.mock.calls[0][0]).toMatchObject({ target: "fr", at: 125.4 });

    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies).toEqual([{ jobId: "j1", since: 0, position: 125.4, sessionId: "sess" }]);
    position = 130;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(s.pollBodies).toHaveLength(2);
    expect(s.pollBodies[1]).toMatchObject({ position: 130 });
    generation.close();
  });

  it("redemande depuis la dernière révision reçue, et insère les lignes triées", async () => {
    const s = fakeServer();
    s.polls = [
      { status: "running", rev: 4, done: 2, total: 10, cues: [{ i: 5, start: 50, end: 52, text: "cinq" }, { i: 4, start: 40, end: 42, text: "quatre" }] },
      { status: "running", rev: 6, done: 3, total: 10, cues: [{ i: 0, start: 1, end: 2, text: "zéro" }] },
    ];
    const { generation } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(s.pollBodies.map((b) => b.since)).toEqual([0, 4]);
    expect(generation.cuesOf("fr").map((c) => c.text)).toEqual(["zéro", "quatre", "cinq"]);
    expect(generation.textAt(41)).toBe("quatre");
    // Recherche non destructive : reculer retrouve sa ligne.
    expect(generation.textAt(1.5)).toBe("zéro");
    generation.close();
  });

  it("ne sonde pas quand la page est cachée, et reprend tout de suite à son retour", async () => {
    const s = fakeServer();
    const { generation } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies).toHaveLength(1);
    visible = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(s.pollBodies).toHaveLength(1);
    // Le retour au premier plan relance le sondage (sans attendre le minuteur, déjà éteint).
    visible = true;
    (generation as unknown as { onVisibility: () => void }).onVisibility();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies).toHaveLength(2);
    generation.close();
  });

  it("une autre piste choisie arrête le sondage ; la réactivation le reprend, lignes gardées", async () => {
    const s = fakeServer();
    s.polls = [{ status: "running", rev: 2, done: 1, total: 10, cues: [{ i: 0, start: 1, end: 2, text: "zéro" }] }];
    const { generation } = make();
    await generation.open();
    const id = await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    generation.activate(null);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(s.pollBodies).toHaveLength(1);
    generation.activate(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies).toHaveLength(2);
    expect(s.pollBodies[1].since).toBe(2);
    expect(generation.textAt(1.5)).toBe("zéro");
    generation.close();
  });

  it("reprise après sortie et retour : l'entrée vient de /options et repart de since 0", async () => {
    const s = fakeServer();
    s.options.jobs = [{ jobId: "j7", target: "fr", status: "running", done: 40, total: 100 }];
    s.polls = [{ status: "running", rev: 9, done: 41, total: 100, cues: [{ i: 0, start: 1, end: 3, text: "déjà traduit" }] }];
    const { generation } = make();
    await generation.open();
    const [entry] = generation.snapshot().jobs;
    generation.activate(entry.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies[0]).toMatchObject({ jobId: "j7", since: 0 });
    expect(generation.textAt(2)).toBe("déjà traduit");
    generation.close();
  });
});

describe("les messages d'état", () => {
  it("« préparation » tant qu'il n'y a rien, puis plus rien dès qu'une vraie ligne couvre l'instant", async () => {
    const s = fakeServer();
    s.polls = [
      { status: "preparing", rev: 0, done: 0, total: 0, cues: [] },
      { status: "running", rev: 3, done: 3, total: 100, cues: [
        { i: 10, start: 100, end: 102, text: "dix" },
        { i: 11, start: 105, end: 107, text: "onze" },
      ] },
    ];
    const { generation, log } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(generation.noticeAt(101)).toEqual({ kind: "preparing" });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Sur une ligne, et dans le silence entre deux lignes consécutives : rien.
    expect(generation.noticeAt(101)).toBeNull();
    expect(generation.noticeAt(103.5)).toBeNull();
    // Avant la zone faite : il manque les lignes 0 à 9.
    expect(generation.noticeAt(50)).toEqual({ kind: "preparing" });
    // Après la dernière ligne reçue, tant qu'elle n'est pas la dernière du film : pas fait.
    expect(generation.noticeAt(200)).toEqual({ kind: "preparing" });

    generation.noteShown();
    expect(events(log)).toContain("première-ligne");
    generation.close();
  });

  it("« reprise » après un saut dans une zone pas encore faite, mesurée jusqu'à la première ligne", async () => {
    const s = fakeServer();
    s.polls = [{ status: "running", rev: 1, done: 1, total: 100, cues: [{ i: 0, start: 1, end: 2, text: "zéro" }] }];
    let now = 1_000;
    const log = vi.fn();
    const generation = new SubtitleGeneration({ itemId: "item-1", position: () => position, log, visible: () => true, now: () => now });
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    generation.noteShown();
    const polls = s.pollBodies.length;

    position = 3000;
    generation.noteSeek(3000);
    expect(generation.noticeAt(3000)).toEqual({ kind: "resuming" });
    // Le serveur l'apprend tout de suite, avec la nouvelle position.
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies).toHaveLength(polls + 1);
    expect(s.pollBodies.at(-1)).toMatchObject({ position: 3000 });

    now += 4_200;
    generation.noteShown();
    const wait = log.mock.calls.map(([f]) => f as Json).find((f) => f.event === "saut-non-traduit");
    expect(wait).toMatchObject({ target: "fr", at: 3000, waitMs: 4_200 });
    expect(generation.noticeAt(3000)).toEqual({ kind: "preparing" });
    generation.close();
  });

  it("« en pause » avec sa raison, et la reprise d'un geste", async () => {
    const s = fakeServer();
    s.polls = [
      { status: "paused", reason: "budget", rev: 0, done: 5, total: 100, cues: [] },
      { status: "running", rev: 1, done: 6, total: 100, cues: [] },
    ];
    const { generation, log } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(generation.noticeAt(10)).toEqual({ kind: "paused", reason: "budget" });
    expect(generation.snapshot().jobs[0]).toMatchObject({ status: "paused", reason: "budget" });
    expect(events(log)).toContain("pause");
    // En pause, le sondage ralentit.
    const polls = s.pollBodies.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(s.pollBodies).toHaveLength(polls);

    await generation.resume("fr");
    expect(s.resumed).toEqual(["j1"]);
    expect(generation.snapshot().jobs[0].status).toBe("running");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies).toHaveLength(polls + 1);
    generation.close();
  });
});

describe("la fin et la bascule vers la piste finale", () => {
  it("finie mais pas présentée : l'entrée reste, sondage lent, sans relire les externes", async () => {
    const s = fakeServer();
    s.polls = [{ status: "done", rev: 3, done: 2, total: 2, cues: [{ i: 0, start: 1, end: 2, text: "a" }, { i: 1, start: 3, end: 4, text: "b" }], presented: false }];
    const { generation, onFinal } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(generation.snapshot().jobs[0]).toMatchObject({ status: "done", presented: false, finalized: false });
    // Les lignes restent affichables, et aucun message dans les trous.
    expect(generation.textAt(3.5)).toBe("b");
    expect(generation.noticeAt(100)).toBeNull();
    const polls = s.pollBodies.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(s.pollBodies).toHaveLength(polls);
    await vi.advanceTimersByTimeAsync(SLOW_POLL_MS);
    expect(s.pollBodies).toHaveLength(polls + 1);
    expect(s.directCalls).toBe(0);
    expect(onFinal).not.toHaveBeenCalled();
    generation.close();
  });

  it("présentée : la liste des externes est relue, la piste générée de la langue rendue, le sondage arrêté", async () => {
    const s = fakeServer();
    s.polls = [
      { status: "done", rev: 3, done: 1, total: 1, cues: [{ i: 0, start: 1, end: 2, text: "a" }], presented: false },
      { status: "done", rev: 3, done: 1, total: 1, cues: [], presented: true },
    ];
    s.externals = [
      { id: -2, language: "fre", title: "Français", url: "/ordinaire" },
      { id: -3, language: "fra", title: null, url: "/genere", generated: true },
    ];
    const { generation, onFinal, log } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SLOW_POLL_MS);
    expect(s.directCalls).toBe(1);
    expect(onFinal).toHaveBeenCalledWith("fr", s.externals[1], s.externals);
    expect(generation.snapshot().jobs[0].finalized).toBe(true);
    expect(generation.activeTarget).toBeNull();
    expect(events(log)).toContain("bascule");
    const polls = s.pollBodies.length;
    await vi.advanceTimersByTimeAsync(SLOW_POLL_MS * 3);
    expect(s.pollBodies).toHaveLength(polls);
    generation.close();
  });

  it("présentée mais pas encore dans la liste : on réessaie plus tard, l'entrée reste", async () => {
    const s = fakeServer();
    s.polls = [{ status: "done", rev: 3, done: 1, total: 1, cues: [], presented: true }];
    const { generation, onFinal } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.directCalls).toBe(1);
    expect(onFinal).not.toHaveBeenCalled();
    expect(generation.snapshot().jobs[0].finalized).toBe(false);
    s.externals = [{ id: -1, language: "fr", title: null, url: "/genere", generated: true }];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onFinal).toHaveBeenCalledTimes(1);
    generation.close();
  });

  it("le repli du serveur : un fichier sans présentation finit par être cherché dans la liste", async () => {
    const s = fakeServer();
    s.polls = [{ status: "done", rev: 3, done: 1, total: 1, cues: [], presented: false, fileUrl: "/api/subtitle-gen/files/j1.vtt" }];
    s.externals = [{ id: -1, language: "fr", title: null, url: "/copie", generated: true }];
    const { generation, onFinal, log } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.directCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(FALLBACK_FILE_AFTER_MS + SLOW_POLL_MS);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([f]) => f as Json).find((f) => f.event === "bascule")).toMatchObject({ via: "repli" });
    generation.close();
  });

  it("une génération qui échoue retire la piste et le dit", async () => {
    const s = fakeServer();
    s.polls = [{ status: "failed", rev: 0, done: 0, total: 0, cues: [] }];
    const { generation, onError, onFailed } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith("job-failed", expect.objectContaining({ target: "fr" }));
    expect(onFailed).toHaveBeenCalledWith("fr");
    expect(generation.activeTarget).toBeNull();
    generation.close();
  });
});

describe("les refus — jamais une exception vers le lecteur", () => {
  it.each([
    [429, "quota"],
    [402, "budget"],
    [422, "no-source"],
  ])("%i : « %s », avec la limite du jour pour le quota", async (status, code) => {
    const s = fakeServer();
    s.create = { status, body: { error: code } };
    const { generation, onError, log } = make();
    await generation.open();
    await expect(generation.generate("fr")).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(code, { target: "fr", quotaLimit: 30 });
    expect(generation.activeTarget).toBeNull();
    expect(generation.snapshot().requesting).toBeNull();
    expect(log.mock.calls.map(([f]) => f as Json).find((f) => f.event === "erreur")).toMatchObject({ code });
  });

  it("409 : la génération existante est reprise plutôt que refusée", async () => {
    const s = fakeServer();
    s.create = { status: 409, body: { error: "exists" } };
    const { generation, onError } = make();
    await generation.open();
    s.options.jobs = [{ jobId: "j5", target: "fr", status: "running", done: 1, total: 9 }];
    const id = await generation.generate("fr");
    expect(isGeneratingTrack(id)).toBe(true);
    expect(generation.activeTarget).toBe("fr");
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies[0].jobId).toBe("j5");
    generation.close();
  });

  it("un sondage sans réponse n'est pas une panne : le suivant repart de la même révision", async () => {
    const s = fakeServer();
    const { generation, onError } = make();
    await generation.open();
    await generation.generate("fr");
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await vi.advanceTimersByTimeAsync(0);
    vi.stubGlobal("fetch", real);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(s.pollBodies.at(-1)).toMatchObject({ since: 0 });
    expect(onError).not.toHaveBeenCalled();
    generation.close();
  });

  it("fermé, plus rien ne part ; rouvert (double montage), tout reprend", async () => {
    const s = fakeServer();
    const { generation } = make();
    await generation.open();
    await generation.generate("fr");
    await vi.advanceTimersByTimeAsync(0);
    generation.close();
    const polls = s.pollBodies.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(s.pollBodies).toHaveLength(polls);
    await generation.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pollBodies.length).toBeGreaterThan(polls);
    generation.close();
  });
});
