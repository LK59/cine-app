import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Le moteur des sous-titres générés, de bout en bout sur une vraie base (DECISIONS.md §69).
 * Aucun appel réseau réel : le fournisseur est simulé (`setProviderFactoryForTests`), Jellyfin
 * aussi (`fetch` doublé) — l'envoi du sous-titre comme sa suppression ne partent jamais.
 */
const env = vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cine-subgen-"));
  process.env.DATA_DIR = dir;
  process.env.JELLYFIN_URL = "http://jf.test";
  process.env.JELLYFIN_API_KEY = "jf-admin-key";
  process.env.SUBTITLE_GEN_API_KEY = "sk-ant-TEST-SECRET-KEY-0001";
  process.env.SUBTITLE_GEN_BUDGET_USD = "5";
  return { dir, key: "sk-ant-TEST-SECRET-KEY-0001" };
});

const jf = vi.hoisted(() => ({ name: "Film" as string, runtimeTicks: 3000 * 1e7 }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemMediaSources: async () => ({ Name: jf.name, RunTimeTicks: jf.runtimeTicks, MediaSources: [currentSource()] }),
  },
}));

import { getDb } from "@/lib/db";
import { setProviderFactoryForTests, ProviderError, type TranslationCall, type TranslationReply } from "@/lib/subtitleGen/providers";
import { cleanupPresented, engineBusy, noteViewer, presentTick, resetEngineForTests, setSeekSettleForTests, setTransientDelaysForTests, startEngine, startForTests, whenIdle } from "@/lib/subtitleGen/engine";
import { adminSummary, createOrJoin, genOptions, pollJob, resume } from "@/lib/subtitleGen/service";
import { cuesDb, jobsDb, quotaDb } from "@/lib/subtitleGen/store";
import { sourceHash } from "@/lib/subtitleGen/source";
import { generatedForDirect } from "@/lib/subtitleGen/direct";
import { readFinal, toVtt } from "@/lib/subtitleGen/files";
import { SUBTITLE_GEN_LOG } from "@/lib/subtitleGen/log";
import { idsAsked } from "@/lib/subtitleGen/prompts";
import type { JellyfinMediaSource, JellyfinMediaStream } from "@/lib/clients/jellyfin";

const ITEM = "a".repeat(32);
const VIDEO = "/media/movies/Film (2020)/Film (2020).mkv";
const OUR_PATH = "/media/movies/Film (2020)/Film (2020).fra.srt";
const N = 120;
const caller = { user: "emma", jfId: "jf-emma", locale: "fr" };

// 120 répliques, une toutes les 25 s, sur 50 minutes : un sous-titre complet.
const fixtureCues = Array.from({ length: N }, (_, i) => ({ start: i * 25, end: i * 25 + 4, text: `Line ${i} source here` }));
const vttOf = (cues: { start: number; end: number; text: string }[]) => toVtt(cues);

let streams: JellyfinMediaStream[] = [];
let sourceVtt = vttOf(fixtureCues);
let ourVtt = "";
let uploadStatus = 204;
const uploads: Record<string, unknown>[] = [];
const deletes: string[] = [];
let etag = "etag-1";

function baseStreams(): JellyfinMediaStream[] {
  return [
    { Type: "Audio", Index: 1, Language: "eng", IsDefault: true, Codec: "eac3" },
    { Type: "Subtitle", Index: 3, Language: "eng", Codec: "subrip" },
    { Type: "Subtitle", Index: 4, Language: "fre", Codec: "subrip", IsForced: true },
  ];
}

function currentSource(): JellyfinMediaSource {
  return { Id: ITEM, ETag: etag, Size: 1000, Path: VIDEO, MediaStreams: streams };
}

const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.startsWith("http://jf.test/Items?Ids=")) return Response.json({ Items: [{ MediaSources: [currentSource()] }] });
  if (/\/Subtitles\/3\/Stream\.vtt$/.test(url)) return new Response(sourceVtt);
  if (/\/Subtitles\/9\/Stream\.vtt$/.test(url)) return new Response(ourVtt);
  if (url === `http://jf.test/Videos/${ITEM}/Subtitles` && method === "POST") {
    uploads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: uploadStatus });
  }
  if (method === "DELETE") {
    deletes.push(url);
    return new Response(null, { status: 204 });
  }
  if (url.includes("/Refresh")) return new Response(null, { status: 204 });
  return new Response(null, { status: 404 });
});
vi.stubGlobal("fetch", fetchStub);

// ─── Le fournisseur simulé ────────────────────────────────────────────────────

const calls: TranslationCall[] = [];
const seenPrefixes = new Set<string>();
let concurrentBatches = 0;
let maxConcurrentBatches = 0;
const GLOSSARY = { source_language: "en", register: "neutre", characters: ["Paul: le héros"], address_forms: ["Paul -> Anne: tu"], terms: [] };

function usageFor(call: TranslationCall) {
  const prefix = [call.system, ...call.stable].join("\u0000");
  const cached = call.cache && seenPrefixes.has(prefix);
  if (call.cache) seenPrefixes.add(prefix);
  return { inputTokens: 40, cacheWriteTokens: call.cache && !cached ? 3000 : 0, cacheReadTokens: cached ? 3000 : 0, outputTokens: 200 };
}

/** Une réponse de lot en lignes `id|texte`, envoyée au fil de l'eau quand l'appel est en flux. */
function linesReply(call: TranslationCall, lines: string[]): TranslationReply {
  const text = lines.join("\n");
  if (call.onText) for (const line of lines) call.onText(`${line}\n`);
  return { text, usage: usageFor(call) };
}

const translateAll = async (call: TranslationCall): Promise<TranslationReply> => {
  if (call.schemaName === "subtitle_glossary") return { json: GLOSSARY, text: JSON.stringify(GLOSSARY), usage: usageFor(call) };
  return linesReply(call, idsAsked(call.user).map((i) => `${i}|Ligne ${i} traduite`));
};
let behavior: (call: TranslationCall) => Promise<TranslationReply> = translateAll;

setProviderFactoryForTests(() => ({
  name: "anthropic",
  model: "claude-haiku-5-5",
  async complete(call) {
    calls.push(call);
    const batch = call.schemaName === "subtitle_batch";
    if (batch) maxConcurrentBatches = Math.max(maxConcurrentBatches, ++concurrentBatches);
    try {
      await new Promise((r) => setTimeout(r, 1));
      return await behavior(call);
    } finally {
      if (batch) concurrentBatches--;
    }
  },
}));

const batchCalls = () => calls.filter((c) => c.schemaName === "subtitle_batch");
const idsOf = (c: TranslationCall) => idsAsked(c.user);

async function settle(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await whenIdle();
    if (!engineBusy()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function logText(): string {
  try {
    return fs.readFileSync(SUBTITLE_GEN_LOG(), "utf8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  resetEngineForTests();
  startForTests();
  setTransientDelaysForTests([0, 0, 0, 0]);
  setSeekSettleForTests(null);
  const db = getDb();
  db.exec("DELETE FROM subtitle_gen_jobs; DELETE FROM subtitle_gen_cues; DELETE FROM subtitle_gen_spend; DELETE FROM subtitle_gen_quota;");
  streams = baseStreams();
  sourceVtt = vttOf(fixtureCues);
  uploadStatus = 204;
  uploads.length = 0;
  deletes.length = 0;
  calls.length = 0;
  seenPrefixes.clear();
  maxConcurrentBatches = 0;
  behavior = translateAll;
  etag = "etag-1";
  process.env.SUBTITLE_GEN_API_KEY = env.key;
  process.env.SUBTITLE_GEN_BUDGET_USD = "5";
});

afterAll(() => {
  resetEngineForTests();
  setProviderFactoryForTests(null);
  vi.unstubAllGlobals();
  fs.rmSync(env.dir, { recursive: true, force: true });
});

async function runJob(position = 1500): Promise<string> {
  const created = await createOrJoin(caller, { itemId: ITEM, target: "fr", position }, "emma:s1");
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("création refusée");
  await settle();
  return created.jobId;
}

describe("une tâche complète", () => {
  it("choisit la piste anglaise complète, part de la position du spectateur, finit et écrit le fichier", async () => {
    const id = await runJob(1500);
    const job = jobsDb.get(id)!;
    expect(job.status).toBe("done");
    expect(job.source_index).toBe(3);
    expect(job.done).toBe(N);
    // Le premier lot : petit, autour de la position (1500 s − 10 s → réplique 60).
    expect(idsOf(batchCalls()[0])).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
    expect(readFinal(ITEM, id, "fr", "srt")).toContain("Ligne 0 traduite");
    expect(readFinal(ITEM, id, "fr", "vtt")).toMatch(/^WEBVTT/);
    // Rien n'est traduit deux fois.
    const all = batchCalls().flatMap(idsOf);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(N);
  });

  it("garde le préfixe identique octet pour octet d'un lot à l'autre, même après un saut, et traduit en série", async () => {
    let jobId = "";
    let seen = 0;
    behavior = async (call) => {
      if (call.schemaName === "subtitle_batch" && ++seen === 3) noteViewer(jobId, "emma:s1", 2900);
      return translateAll(call);
    };
    const created = await createOrJoin(caller, { itemId: ITEM, target: "fr", position: 100 }, "emma:s1");
    if (!created.ok) throw new Error("refus");
    jobId = created.jobId;
    await settle();

    const withGlossary = batchCalls().filter((c) => c.stable.length === 2);
    expect(withGlossary.length).toBeGreaterThanOrEqual(2);
    const prefix = (c: TranslationCall) => JSON.stringify([c.system, ...c.stable]);
    for (const c of withGlossary) expect(prefix(c)).toBe(prefix(withGlossary[0]));
    // Le saut a bien été suivi : un lot part de 2900 s − 10 s (réplique 116).
    expect(batchCalls().some((c) => idsOf(c)[0] === 116)).toBe(true);
    // Rien de variable dans le préfixe : ni position, ni identifiants demandés.
    expect(withGlossary[0].stable.join("")).not.toContain("translate");
    // Le bloc source est le même que celui du glossaire.
    const glossaryCall = calls.find((c) => c.schemaName === "subtitle_glossary")!;
    expect(withGlossary[0].stable[1]).toBe(glossaryCall.stable[0]);
    expect(glossaryCall.cache).toBe(false);
    // Une requête à la fois pour une tâche : le cache ne se partage qu'en série.
    expect(maxConcurrentBatches).toBe(1);
    // Le cache est relu : la ligne `done` le dit.
    const done = logText().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.kind === "done" && l.job === jobId);
    expect(done.cacheReadTokens).toBeGreaterThan(0);
    expect(done.cacheWriteTokens).toBeGreaterThan(0);
    expect(done.cacheReadRate).toBeGreaterThan(0.5);
  });

  it("compte la dépense exacte, cache compris", async () => {
    const id = await runJob();
    const job = jobsDb.get(id)!;
    const expected = (job.input_tokens * 0.1 + job.cache_write_tokens * 0.125 + job.cache_read_tokens * 0.01 + job.output_tokens * 0.5) / 1e6;
    expect(job.cost_usd).toBeCloseTo(expected, 10);
    expect(adminSummary().month.cost).toBeCloseTo(expected, 10);
  });
});

describe("le premier lot et le flux", () => {
  it("fait partir le premier lot pendant le glossaire, et seulement lui", async () => {
    // Le 12/10/2026 en prod : la tâche restait `busy` pendant tout le glossaire, et le « premier lot
    // en parallèle » l'attendait — 18,5 s avant la première ligne.
    let releaseGlossary: () => void = () => undefined;
    const glossaryHeld = new Promise<void>((r) => (releaseGlossary = r));
    let batchesDuringGlossary = 0;
    let glossaryPending = false;
    let glossaryResolved = false;
    behavior = async (call) => {
      if (call.schemaName === "subtitle_glossary") {
        glossaryPending = true;
        await glossaryHeld;
        glossaryPending = false;
        glossaryResolved = true;
      } else if (!glossaryResolved) batchesDuringGlossary++;
      return translateAll(call);
    };
    const created = await createOrJoin(caller, { itemId: ITEM, target: "fr", position: 1500 }, "emma:s1");
    if (!created.ok) throw new Error("refus");
    for (let k = 0; k < 400 && !(glossaryPending && cuesDb.all(created.jobId).some((c) => c.text !== null && !c.provisional)); k++) await new Promise((r) => setTimeout(r, 5));
    // Le premier lot est fait, glossaire toujours en attente — et rien d'autre n'est parti.
    await new Promise((r) => setTimeout(r, 30));
    expect(glossaryPending).toBe(true);
    expect(batchesDuringGlossary).toBe(1);
    expect(jobsDb.get(created.jobId)!.done).toBe(8);
    const first = logText().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.kind === "first" && l.job === created.jobId);
    expect(first).toMatchObject({ streamed: true });
    expect(first.clickToFirstMs).toBe(first.ms);
    expect(typeof first.requestToFirstMs).toBe("number");
    releaseGlossary();
    await settle();
    expect(jobsDb.get(created.jobId)!.status).toBe("done");
    expect(batchesDuringGlossary).toBe(1);
    const done = logText().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.kind === "done" && l.job === created.jobId);
    expect(done.outputTokensPerLine).toBeGreaterThan(0);
  });

  it("écrit chaque ligne reçue en flux avant la fin du lot, provisoire, puis la valide", async () => {
    let jobId = "";
    const seenMidStream: { rev: number; texts: string[]; provisional: number[] }[] = [];
    behavior = async (call) => {
      if (call.schemaName !== "subtitle_batch" || seenMidStream.length > 0) return translateAll(call);
      const ids = idsOf(call);
      call.onText!(`${ids[0]}|Ligne ${ids[0]} traduite\n${ids[1]}|Ligne`);
      const poll = pollJob(jobId, 0, undefined, "emma:s1")!;
      seenMidStream.push({ rev: poll.rev, texts: poll.cues.map((c) => c.text), provisional: cuesDb.all(jobId).filter((c) => c.provisional).map((c) => c.idx) });
      call.onText!(` ${ids[1]} traduite\n`);
      for (const i of ids.slice(2)) call.onText!(`${i}|Ligne ${i} traduite\n`);
      return { text: ids.map((i) => `${i}|Ligne ${i} traduite`).join("\n"), usage: usageFor(call) };
    };
    const created = await createOrJoin(caller, { itemId: ITEM, target: "fr", position: 1500 }, "emma:s1");
    if (!created.ok) throw new Error("refus");
    jobId = created.jobId;
    await settle();
    // Au milieu du lot : la première ligne, complète, est déjà au sondage ; la seconde, coupée, pas encore.
    expect(seenMidStream[0].texts).toEqual(["Ligne 60 traduite"]);
    expect(seenMidStream[0].provisional).toEqual([60]);
    expect(seenMidStream[0].rev).toBeGreaterThan(0);
    const job = jobsDb.get(jobId)!;
    expect(job.status).toBe("done");
    expect(cuesDb.all(jobId).every((c) => !c.provisional && c.text === `Ligne ${c.idx} traduite`)).toBe(true);
  });

  it("retire les lignes d'un lot refusé et les remplace par le nouvel essai, que le sondage rend", async () => {
    let jobId = "";
    let attempt = 0;
    let revAfterRejected = 0;
    behavior = async (call) => {
      if (call.schemaName !== "subtitle_batch") return translateAll(call);
      attempt++;
      const ids = idsOf(call);
      if (attempt === 1) {
        // Toutes les lignes sauf la dernière : le lot est refusé (« manquant ») une fois le flux fini.
        return linesReply(call, ids.slice(0, -1).map((i) => `${i}|Mauvaise ${i}`));
      }
      if (attempt === 2) revAfterRejected = jobsDb.get(jobId)!.rev;
      return translateAll(call);
    };
    const created = await createOrJoin(caller, { itemId: ITEM, target: "fr", position: 1500 }, "emma:s1");
    if (!created.ok) throw new Error("refus");
    jobId = created.jobId;
    await settle();
    // Le lecteur qui avait reçu les lignes refusées (révision ≤ revAfterRejected) reçoit leurs remplaçantes.
    const later = pollJob(jobId, revAfterRejected, undefined, "emma:s1")!;
    for (const i of [60, 61, 62]) expect(later.cues.find((c) => c.i === i)?.text).toBe(`Ligne ${i} traduite`);
    expect(cuesDb.all(jobId).some((c) => (c.text ?? "").startsWith("Mauvaise"))).toBe(false);
    expect(jobsDb.get(jobId)!.status).toBe("done");
    expect(logText()).toMatch(/"kind":"retry"[^\n]*"cause":"manquant"/);
  });

  it("rend la casse d'une source tout en capitales, et elle seule", async () => {
    sourceVtt = vttOf(fixtureCues.map((c, i) => ({ ...c, text: i % 2 === 0 ? `WHERE ARE YOU ${i}?` : c.text })));
    behavior = async (call) =>
      call.schemaName === "subtitle_batch" ? linesReply(call, idsOf(call).map((i) => `${i}|où êtes-vous ${i} ?`)) : translateAll(call);
    const id = await runJob(0);
    const rows = cuesDb.all(id);
    expect(rows[0].text).toBe("OÙ ÊTES-VOUS 0 ?");
    expect(rows[1].text).toBe("où êtes-vous 1 ?");
  });
});

describe("reprise après un redémarrage", () => {
  function seedRunning(hash = sourceHash(fixtureCues)): string {
    const id = "c".repeat(32);
    jobsDb.insert({
      id,
      item_id: ITEM,
      media_source_id: ITEM,
      file_etag: "etag-1",
      file_size: 1000,
      video_path: VIDEO,
      title: "Film",
      runtime_seconds: 3000,
      target: "fr",
      candidates: "[]",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      created_by: "emma",
      last_position: null,
    });
    cuesDb.replaceAll(id, fixtureCues);
    jobsDb.update(id, { status: "running", total: N, source_index: 3, source_hash: hash, glossary: JSON.stringify(GLOSSARY) });
    cuesDb.write(id, Array.from({ length: 40 }, (_, i) => ({ idx: i, text: `Déjà ${i}`, kept: false })));
    return id;
  }

  it("garde les lignes acquises et ne les retraduit pas", async () => {
    const id = seedRunning();
    resetEngineForTests();
    startEngine();
    await settle();
    const job = jobsDb.get(id)!;
    expect(job.status).toBe("done");
    expect(batchCalls().flatMap(idsOf).filter((i) => i < 40)).toEqual([]);
    expect(readFinal(ITEM, id, "fr", "srt")).toContain("Déjà 0");
    resetEngineForTests();
  });

  it("rend obsolète une tâche dont le sous-titre source a changé", async () => {
    const id = seedRunning("autre-empreinte");
    resetEngineForTests();
    startEngine();
    await settle();
    expect(jobsDb.get(id)!.status).toBe("stale");
    expect(batchCalls()).toEqual([]);
    resetEngineForTests();
  });

  it("rend obsolète une tâche dont le fichier vidéo a été remplacé", async () => {
    const id = seedRunning();
    etag = "etag-2";
    resetEngineForTests();
    startEngine();
    await settle();
    expect(jobsDb.get(id)!.status).toBe("stale");
    resetEngineForTests();
  });
});

describe("les pauses", () => {
  it("met en pause `unavailable` après des 429 répétés, et reprend sur demande", async () => {
    behavior = async (call) => {
      if (call.schemaName === "subtitle_batch") throw new ProviderError("rate", "limite");
      return translateAll(call);
    };
    const id = await runJob();
    expect(jobsDb.get(id)).toMatchObject({ status: "paused", reason: "unavailable" });
    expect(logText()).toContain('"kind":"retry"');
    behavior = translateAll;
    expect(resume(id)?.status).toBe("running");
    await settle();
    expect(jobsDb.get(id)!.status).toBe("done");
  });

  it("met en pause `budget` quand le crédit est épuisé", async () => {
    behavior = async (call) => {
      if (call.schemaName === "subtitle_batch") throw new ProviderError("credit", "crédit");
      return translateAll(call);
    };
    const id = await runJob();
    expect(jobsDb.get(id)).toMatchObject({ status: "paused", reason: "budget" });
  });

  it("met en pause `config` quand la clé est refusée", async () => {
    behavior = async () => {
      throw new ProviderError("auth", "clé");
    };
    const id = await runJob();
    expect(jobsDb.get(id)).toMatchObject({ status: "paused", reason: "config" });
  });

  it("met en pause `budget` quand le budget du mois est atteint, et refuse d'en lancer d'autres (402)", async () => {
    process.env.SUBTITLE_GEN_BUDGET_USD = "0.00001";
    const id = await runJob();
    expect(jobsDb.get(id)).toMatchObject({ status: "paused", reason: "budget" });
    jf.name = "Autre";
    const other = await createOrJoin(caller, { itemId: "d".repeat(32), target: "de" }, "emma:s1");
    expect(other).toMatchObject({ ok: false, status: 402, error: "budget" });
    // Reprendre ne passe pas outre.
    expect(resume(id)).toMatchObject({ status: "paused", reason: "budget" });
    jf.name = "Film";
  });

  it("garde en langue source la ligne que le modèle refuse, et finit quand même", async () => {
    behavior = async (call) => {
      if (call.schemaName === "subtitle_batch" && idsOf(call).includes(7)) throw new ProviderError("refusal", "refus", { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
      return translateAll(call);
    };
    const id = await runJob(0);
    const job = jobsDb.get(id)!;
    expect(job.status).toBe("done");
    expect(job.kept_source).toBe(1);
    expect(cuesDb.all(id)[7]).toMatchObject({ text: "Line 7 source here", kept: 1 });
    expect(logText()).toContain('"kind":"refusal"');
  });

  it("réessaie un lot invalide, puis le réduit de moitié", async () => {
    let broken = 2;
    behavior = async (call) => {
      if (call.schemaName === "subtitle_batch" && broken-- > 0) return { text: "", usage: usageFor(call) };
      return translateAll(call);
    };
    const id = await runJob(0);
    expect(jobsDb.get(id)!.status).toBe("done");
    const sizes = batchCalls().slice(0, 4).map((c) => idsOf(c).length);
    expect(sizes).toEqual([8, 8, 4, 4]);
  });
});

describe("le quota quotidien", () => {
  it("refuse la 51e génération du jour, mais rejoindre ou relancer ne compte pas", async () => {
    // Tout se met en pause au premier lot : on ne mesure ici que les lancements.
    behavior = async () => {
      throw new ProviderError("auth", "clé");
    };
    const hex = (n: number) => n.toString(16).padStart(32, "0");
    for (let n = 1; n <= 50; n++) {
      expect((await createOrJoin(caller, { itemId: hex(n), target: "fr" }, "emma:s1")).ok).toBe(true);
    }
    await settle();
    expect(quotaDb.used("emma")).toBe(50);
    expect(await createOrJoin(caller, { itemId: hex(51), target: "fr" }, "emma:s1")).toMatchObject({ ok: false, status: 429, error: "quota" });
    // Rejoindre une tâche existante : accepté, sans compter.
    expect((await createOrJoin(caller, { itemId: hex(1), target: "fr" }, "emma:s2")).ok).toBe(true);
    expect(quotaDb.used("emma")).toBe(50);
    // Un autre compte a son propre quota.
    expect((await createOrJoin({ ...caller, user: "lucas" }, { itemId: hex(51), target: "fr" }, "lucas:s1")).ok).toBe(true);
    await settle();
  });
});

describe("le contrat des options et du sondage", () => {
  it("propose la langue du compte d'abord, sans celles déjà présentes en complet", async () => {
    const options = await genOptions(caller, ITEM);
    expect(options.enabled).toBe(true);
    expect(options.existing).toEqual(["en"]);
    expect(options.targets[0]).toBe("fr");
    expect(options.targets).not.toContain("en");
    expect(options.quota).toEqual({ used: 0, limit: 50 });
  });

  it("n'existe pas sans clé", async () => {
    process.env.SUBTITLE_GEN_API_KEY = "";
    expect(await genOptions(caller, ITEM)).toMatchObject({ enabled: false, targets: [], jobs: [] });
    expect(await createOrJoin(caller, { itemId: ITEM, target: "fr" }, "emma:s1")).toMatchObject({ ok: false, status: 404 });
  });

  it("refuse une langue déjà présente (409) et un titre sans source texte (422)", async () => {
    expect(await createOrJoin(caller, { itemId: ITEM, target: "en" }, "emma:s1")).toMatchObject({ ok: false, status: 409, error: "exists" });
    streams = [{ Type: "Audio", Index: 1, Language: "eng" }, { Type: "Subtitle", Index: 2, Language: "eng", Codec: "PGSSUB" }];
    expect(await createOrJoin(caller, { itemId: ITEM, target: "fr" }, "emma:s1")).toMatchObject({ ok: false, status: 422, error: "no-source" });
  });

  it("rend les lignes depuis une révision, et l'adresse du fichier une fois fini", async () => {
    const id = await runJob(0);
    const first = pollJob(id, 0, 10, "emma:s1")!;
    expect(first).toMatchObject({ status: "done", done: N, total: N, fileUrl: `/api/subtitle-gen/files/${id}.vtt` });
    expect(first.cues).toHaveLength(N);
    expect(first.cues[0]).toEqual({ i: 0, start: 0, end: 4, text: "Ligne 0 traduite" });
    expect(pollJob(id, first.rev, 10, "emma:s1")!.cues).toEqual([]);
    const options = await genOptions(caller, ITEM);
    expect(options.jobs).toEqual([{ jobId: id, target: "fr", status: "done", done: N, total: N, presented: false }]);
  });
});

describe("la clé ne sort jamais", () => {
  it("ni dans le panneau d'administration, ni dans le journal, et le texte des sous-titres non plus", async () => {
    await runJob();
    expect(JSON.stringify(adminSummary())).not.toContain(env.key);
    expect(adminSummary().hasKey).toBe(true);
    const log = logText();
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(env.key);
    expect(log).not.toContain("source here");
    expect(log).not.toContain("traduite");
  });
});

describe("la présentation à Jellyfin", () => {
  it("envoie le .srt, attend que Jellyfin le liste, puis le marque comme le nôtre", async () => {
    const id = await runJob();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ Language: "fra", Format: "srt", IsForced: false, IsHearingImpaired: false });
    expect(Buffer.from(String(uploads[0].Data), "base64").toString("utf8")).toContain("Ligne 0 traduite");
    expect(jobsDb.get(id)!.present_state).toBe("uploaded");
    // Pas encore listé : ni marqué, ni remplacé par la copie de data/.
    expect(pollJob(id, 0, undefined, "emma:s1")!.presented).toBe(false);
    expect(generatedForDirect(ITEM, currentSource(), streams)).toEqual({ ours: new Set(), fallbacks: [] });

    streams = [...streams, { Type: "Subtitle", Index: 9, Language: "fra", Codec: "subrip", IsExternal: true, Path: OUR_PATH }];
    await presentTick();
    expect(jobsDb.get(id)).toMatchObject({ present_state: "presented", present_path: OUR_PATH, present_index: 9 });
    expect(pollJob(id, 0, undefined, "emma:s1")!.presented).toBe(true);
    expect(generatedForDirect(ITEM, currentSource(), streams).ours).toEqual(new Set([9]));
    // Désormais présente en complet : plus proposée.
    expect((await genOptions(caller, ITEM)).targets).not.toContain("fr");
  });

  it("sert la copie de data/ quand l'envoi échoue pour de bon", async () => {
    uploadStatus = 500;
    const id = await runJob();
    for (let k = 1; k <= 5; k++) await presentTick(Date.now() + k * 24 * 3600_000);
    expect(jobsDb.get(id)).toMatchObject({ present_state: "failed" });
    expect(generatedForDirect(ITEM, currentSource(), streams).fallbacks).toEqual([{ language: "fr", url: `/api/subtitle-gen/files/${id}.vtt` }]);
    expect((await genOptions(caller, ITEM)).existing).toContain("fr");
  });

  it("n'écrase jamais un fichier voisin qui porte déjà le nom", async () => {
    streams = [...streams, { Type: "Subtitle", Index: 8, Codec: "subrip", IsExternal: true, Path: OUR_PATH, Language: "und" }];
    const id = await runJob();
    expect(uploads).toEqual([]);
    expect(jobsDb.get(id)).toMatchObject({ present_state: "failed", present_reason: "name-taken" });
  });

  it("ne supprime un sous-titre posé que s'il est le nôtre avec certitude", async () => {
    const id = await runJob();
    streams = [...streams, { Type: "Subtitle", Index: 9, Language: "fra", Codec: "subrip", IsExternal: true, Path: OUR_PATH }];
    await presentTick();
    const job = jobsDb.get(id)!;
    // Même chemin, autre texte : quelqu'un l'a remplacé. On ne touche à rien.
    ourVtt = vttOf([{ start: 0, end: 1, text: "Autre chose" }]);
    expect(await cleanupPresented(job)).toBe("skipped");
    expect(deletes).toEqual([]);
    // Un autre chemin : jamais.
    expect(await cleanupPresented({ ...job, present_path: "/media/autre.fra.srt" })).toBe("skipped");
    expect(deletes).toEqual([]);
    // Le même chemin et le même texte : le nôtre.
    ourVtt = vttOf(cuesDb.all(id).map((c) => ({ start: c.start_s, end: c.end_s, text: c.text! })));
    expect(await cleanupPresented(job)).toBe("deleted");
    expect(deletes).toEqual([`http://jf.test/Videos/${ITEM}/Subtitles/9`]);
  });
});

// Le dossier temporaire de cette suite : rien n'est écrit dans le vrai data/.
it("écrit dans un dossier jetable", () => {
  expect(env.dir.startsWith(os.tmpdir())).toBe(true);
  expect(fs.existsSync(path.join(env.dir, "cine.db"))).toBe(true);
});

describe("le lot de saut", () => {
  // Mesuré en prod le 12/10/2026 (8.43.1) : un saut dans une zone non traduite couvert en 6,1 s, le
  // lot de 40 en cours devant finir d'abord. Le lot de saut part à côté de lui.
  const logLines = () => logText().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const until = async (cond: () => boolean) => {
    for (let k = 0; k < 400 && !cond(); k++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };
  const batchStarting = (i: number) => batchCalls().filter((c) => idsOf(c)[0] === i);

  /**
   * Une tâche partie à 100 s (premier lot 4-11, fait) dont le lot ordinaire suivant (12-51) reste en
   * vol jusqu'à `release(12)` ; `holdFirstIds` retient aussi les lots qui commencent par ces ids.
   */
  async function jobWithHeldBatch(holdFirstIds: number[] = []) {
    const releases = new Map<number, () => void>();
    const held = new Map<number, Promise<void>>();
    for (const i of [12, ...holdFirstIds]) held.set(i, new Promise<void>((r) => releases.set(i, r)));
    behavior = async (call) => {
      if (call.schemaName === "subtitle_batch") {
        const wait = held.get(idsOf(call)[0]);
        if (wait) await wait;
      }
      return translateAll(call);
    };
    const created = await createOrJoin(caller, { itemId: ITEM, target: "fr", position: 100 }, "emma:s1");
    if (!created.ok) throw new Error("refus");
    await until(() => batchStarting(12).length === 1);
    return { jobId: created.jobId, release: (i: number) => releases.get(i)!() };
  }

  it("part tout de suite, en parallèle du lot en cours, au même préfixe, sans rien traduire deux fois", async () => {
    setSeekSettleForTests(20);
    const { jobId, release } = await jobWithHeldBatch();
    noteViewer(jobId, "emma:s1", 2000);
    // 2000 s − 10 s → réplique 80 ; 8 répliques, pendant que 12-51 est toujours en vol.
    await until(() => batchStarting(80).length === 1);
    expect(idsOf(batchStarting(80)[0])).toEqual([80, 81, 82, 83, 84, 85, 86, 87]);
    await until(() => cuesDb.all(jobId).filter((c) => c.idx >= 80 && c.idx < 88).every((c) => c.text !== null && !c.provisional));
    expect(maxConcurrentBatches).toBe(2);
    // Le même préfixe que le lot en cours : le cache écrit par lui est relu.
    const prefix = (c: TranslationCall) => JSON.stringify([c.system, ...c.stable]);
    expect(prefix(batchStarting(80)[0])).toBe(prefix(batchStarting(12)[0]));
    const seek = logLines().find((l) => l.kind === "seek" && l.job === jobId);
    expect(seek).toMatchObject({ fastLane: true, from: 100, to: 2000, jumps: 1 });
    const first = logLines().find((l) => l.kind === "seekFirst" && l.job === jobId);
    expect(first).toMatchObject({ fastLane: true, streamed: true });
    expect(first.seekToFirstMs).toBeGreaterThanOrEqual(20);
    release(12);
    await settle();
    const job = jobsDb.get(jobId)!;
    expect(job.status).toBe("done");
    // Le lot ordinaire n'a pas été annulé, et aucune réplique n'a été demandée deux fois.
    const all = batchCalls().flatMap(idsOf);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(N);
    // Le coût compté normalement : chaque appel facturé, cache compris.
    expect(job.requests).toBe(calls.length);
    const expected = (job.input_tokens * 0.1 + job.cache_write_tokens * 0.125 + job.cache_read_tokens * 0.01 + job.output_tokens * 0.5) / 1e6;
    expect(job.cost_usd).toBeCloseTo(expected, 10);
  });

  it("un seul lot de saut à la fois par tâche : le suivant attend, et le dernier saut l'emporte", async () => {
    setSeekSettleForTests(20);
    const { jobId, release } = await jobWithHeldBatch([80]);
    noteViewer(jobId, "emma:s1", 2000);
    await until(() => batchStarting(80).length === 1);
    noteViewer(jobId, "emma:s1", 2800);
    await until(() => logLines().filter((l) => l.kind === "seek" && l.job === jobId).length === 2);
    noteViewer(jobId, "emma:s1", 2400);
    await until(() => logLines().filter((l) => l.kind === "seek" && l.job === jobId).length === 3);
    const seeks = logLines().filter((l) => l.kind === "seek" && l.job === jobId);
    expect(seeks[1]).toMatchObject({ fastLane: true, queued: true, to: 2800 });
    expect(seeks[2]).toMatchObject({ fastLane: true, queued: true, to: 2400 });
    await new Promise((r) => setTimeout(r, 30));
    // Rien de plus n'est parti : un lot ordinaire et un lot de saut en vol, pas deux lots de saut.
    expect(batchCalls()).toHaveLength(3);
    release(80);
    // Le lot de saut suivant part à la dernière position (2390 s → réplique 96), pas à 2800 (112).
    await until(() => batchStarting(96).length === 1);
    expect(idsOf(batchStarting(96)[0])).toHaveLength(8);
    expect(batchStarting(112)).toHaveLength(0);
    expect(maxConcurrentBatches).toBe(2);
    release(12);
    await settle();
    const all = batchCalls().flatMap(idsOf);
    expect(new Set(all).size).toBe(all.length);
    expect(jobsDb.get(jobId)!.status).toBe("done");
  });

  it("une rafale de sauts : un seul lot, à la dernière position, une seconde après le dernier", async () => {
    const { jobId, release } = await jobWithHeldBatch();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const base = Date.now();
      // Cinq appuis espacés de 300 ms : 1500, 1700, 1900, 2100, 2300 s.
      for (let k = 0; k < 5; k++) {
        if (k > 0) await vi.advanceTimersByTimeAsync(300);
        noteViewer(jobId, "emma:s1", 1500 + 200 * k, base + 300 * k);
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(batchCalls()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(batchCalls()).toHaveLength(3);
      // 2300 s − 10 s → réplique 92 ; aucune des positions intermédiaires (60, 68, 76, 84).
      expect(idsOf(batchCalls()[2])).toEqual([92, 93, 94, 95, 96, 97, 98, 99]);
      for (const i of [60, 68, 76, 84]) expect(batchStarting(i)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }
    const seeks = logLines().filter((l) => l.kind === "seek" && l.job === jobId);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toMatchObject({ fastLane: true, from: 100, to: 2300, jumps: 5 });
    release(12);
    await settle();
    const all = batchCalls().flatMap(idsOf);
    expect(new Set(all).size).toBe(all.length);
  });

  it("un saut vers une zone faite ou déjà en vol ne lance rien", async () => {
    setSeekSettleForTests(20);
    const { jobId, release } = await jobWithHeldBatch();
    // 160 s − 10 s → réplique 6, faite par le premier lot.
    noteViewer(jobId, "emma:s1", 160);
    await until(() => logLines().some((l) => l.kind === "seek" && l.job === jobId));
    // 700 s − 10 s → réplique 28, dans le lot 12-51 en vol.
    noteViewer(jobId, "emma:s1", 700);
    await until(() => logLines().filter((l) => l.kind === "seek" && l.job === jobId).length === 2);
    // Deux appuis sur +10 s vers une zone en vol : ni lot, ni ligne `seek`.
    noteViewer(jobId, "emma:s1", 710);
    noteViewer(jobId, "emma:s1", 720);
    await new Promise((r) => setTimeout(r, 60));
    const seeks = logLines().filter((l) => l.kind === "seek" && l.job === jobId);
    expect(seeks).toHaveLength(2);
    expect(seeks[0]).toMatchObject({ fastLane: false, why: "done" });
    expect(seeks[1]).toMatchObject({ fastLane: false, why: "inflight" });
    expect(batchCalls()).toHaveLength(2);
    expect(logLines().some((l) => l.kind === "seekFirst" && l.job === jobId)).toBe(false);
    release(12);
    await settle();
  });
});
