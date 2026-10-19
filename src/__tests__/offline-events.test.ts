import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Le journal du téléchargement hors ligne (19/10/2026, `offline/events.ts`) : chaque geste d'un
 * compte et chaque étape d'une version écrit une ligne `scope: "offline"` dans `server.log`, avec le
 * titre résolu côté serveur (« Série — S01E02 » pour un épisode) — et jamais une ligne par plage.
 */
const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cine-offline-log-"));
  process.env.DATA_DIR = d;
  process.env.JELLYFIN_URL = "http://jf";
  process.env.JELLYFIN_API_KEY = "k";
  return d as string;
});
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
const upstream = vi.fn();
vi.mock("@/lib/jellyfinBreaker", () => ({ passJellyfinFetch: (...a: unknown[]) => upstream(...a) }));

import { getDb } from "@/lib/db";
import { deleteOfflineCopy, forgetOfflineJob, listOfflineCopies, offlineFile, offlineJobFor, requestOfflineJob, sweepOfflineJobs } from "@/lib/offline/jobs";
import { __testing, noteOfflineServed, titleOfItem } from "@/lib/offline/events";
import { recentDownloadEvents } from "@/lib/activity/offlineDownloads";
import { lineUsers } from "@/lib/activity/logReader";

const ITEM = "a".repeat(32);
const FIXTURE = fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/offline/jellyfin-like.mp4"));
const episode = {
  Id: ITEM,
  Type: "Episode",
  Name: "Le pilote",
  SeriesName: "Ted Lasso",
  ParentIndexNumber: 1,
  IndexNumber: 2,
  RunTimeTicks: 3e7,
  MediaSources: [{ Id: ITEM, ETag: "v1", MediaStreams: [{ Type: "Video", Index: 0 }, { Type: "Audio", Index: 1, DisplayTitle: "Français - AAC - Stéréo" }] }],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const LOG = path.join(dir, "logs", "server.log");
const lines = () =>
  fs.existsSync(LOG)
    ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.scope === "offline")
    : [];
const events = () => lines().map((l) => l.event);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  upstream.mockReset();
  __testing.reset();
  getDb().exec("DELETE FROM offline_jobs; DELETE FROM offline_requests;");
  fs.rmSync(LOG, { force: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("titleOfItem", () => {
  it("un épisode se dit « Série — S01E02 », un film par son nom", () => {
    expect(titleOfItem(episode)).toBe("Ted Lasso — S01E02");
    expect(titleOfItem({ Type: "Movie", Name: "1917" })).toBe("1917");
  });
});

describe("le journal du téléchargement hors ligne", () => {
  it("la demande : compte, titre, qualité, piste, et si la version existait déjà", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json({ Items: [episode] }));
    await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc" });
    await requestOfflineJob({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc" });
    await vi.waitFor(() => expect(lines()).toHaveLength(2));
    const [first, second] = lines();
    expect(first).toMatchObject({ level: "info", event: "requested", user: "louis", title: "Ted Lasso — S01E02", quality: "high", codec: "hevc", audioIndex: 1, audio: "Français - AAC - Stéréo", copy: "new" });
    expect(second).toMatchObject({ user: "mathis", copy: "preparing" });
  });

  it("préparation : commencée puis prête, avec durée, taille, vitesse et les comptes ; récupérée une seule fois", async () => {
    process.env.OFFLINE_DOWNLOADS = "true";
    upstream.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/stream.mp4")) return new Response(new Uint8Array(FIXTURE), { status: 200 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ Items: [episode] });
    });
    const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "h264" });
    await vi.waitFor(() => expect(events()).toContain("ready"), { timeout: 3000 });
    const ready = lines().find((l) => l.event === "ready")!;
    expect(ready).toMatchObject({ accounts: ["louis"], bytes: FIXTURE.length, title: "Ted Lasso — S01E02" });
    expect(typeof ready.durationMs).toBe("number");
    expect(events()).toEqual(["requested", "started", "ready"]);
    // La ligne d'une version sans auteur est rangée sous chacun de ses comptes (filtre « Compte »).
    expect(lineUsers(ready)).toEqual(["louis"]);

    // Une plage du milieu n'écrit rien ; la dernière, une fois par compte — pas à chaque reprise.
    const done = offlineJobFor("louis", job.id)!;
    noteOfflineServed("louis", done, 1000);
    noteOfflineServed("louis", done, done.bytes - 1);
    noteOfflineServed("louis", done, done.bytes - 1);
    await vi.waitFor(() => expect(events().filter((e) => e === "fetched")).toHaveLength(1));
    expect(lines().find((l) => l.event === "fetched")).toMatchObject({ user: "louis", bytes: done.bytes });
    expect(fs.existsSync(offlineFile(job.id))).toBe(true);

    // Retirée de l'appareil : « supprimé », la version reste sur le serveur.
    forgetOfflineJob("louis", job.id);
    await vi.waitFor(() => expect(events()).toContain("removed"));
    expect(listOfflineCopies()).toHaveLength(1);

    // Plus téléchargée depuis plus de trois jours : effacée par le balayage, et dit.
    sweepOfflineJobs(Date.now() + 4 * 24 * 3600_000);
    await vi.waitFor(() => expect(events()).toContain("expired"));
    expect(lines().find((l) => l.event === "expired")).toMatchObject({ status: "done", title: "Ted Lasso — S01E02" });
    expect(listOfflineCopies()).toHaveLength(0);
    // Et la page Téléchargements de l'activité les relit, la plus récente d'abord.
    expect(recentDownloadEvents(Date.now()).map((r) => r.event)).toEqual(["expired", "removed", "fetched", "ready", "started", "requested"]);
  });

  it("un échec s'écrit en erreur avec sa raison ; une annulation dit si la préparation s'arrête", async () => {
    process.env.OFFLINE_DOWNLOADS = "true";
    upstream.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/stream.mp4")) return new Response(new Uint8Array(FIXTURE), { status: 200 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ Items: [{ ...episode, RunTimeTicks: 7200e7 }] });
    });
    await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "standard", codec: "hevc" });
    await vi.waitFor(() => expect(events()).toContain("failed"), { timeout: 3000 });
    expect(lines().find((l) => l.event === "failed")).toMatchObject({ level: "error", accounts: ["louis"], reason: expect.stringMatching(/interrompu/) });

    process.env.OFFLINE_DOWNLOADS = "false";
    getDb().exec("DELETE FROM offline_jobs; DELETE FROM offline_requests;");
    const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc" });
    forgetOfflineJob("louis", job.id);
    await vi.waitFor(() => expect(events()).toContain("cancelled"));
    expect(lines().find((l) => l.event === "cancelled")).toMatchObject({ user: "louis", status: "queued", stopped: true });
  });

  it("l'administrateur efface une version : ligne à son nom, avec les comptes qui l'attendaient", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json({ Items: [episode] }));
    const job = await requestOfflineJob({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc" });
    expect(deleteOfflineCopy(job.id, "louis")).toBe(true);
    expect(deleteOfflineCopy(job.id, "louis")).toBe(false);
    await vi.waitFor(() => expect(events()).toContain("deleted"));
    expect(lines().find((l) => l.event === "deleted")).toMatchObject({ user: "louis", accounts: ["mathis"] });
    expect(offlineJobFor("mathis", job.id)).toBeNull();
  });

  it("la liste de l'administrateur : comptes, expiration selon les règles du balayage", async () => {
    process.env.OFFLINE_DOWNLOADS = "false";
    upstream.mockImplementation(async () => json({ Items: [episode] }));
    const job = await requestOfflineJob({ account: "louis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc", now: 1000 });
    await requestOfflineJob({ account: "mathis", itemId: ITEM, audioIndex: 1, quality: "high", codec: "hevc", now: 2000 });
    expect(listOfflineCopies()[0]).toMatchObject({ id: job.id, status: "queued", accounts: ["louis", "mathis"], expiresAt: null });
    getDb().prepare("UPDATE offline_jobs SET status = 'done', accessed_at = 5000 WHERE id = ?").run(job.id);
    expect(listOfflineCopies()[0].expiresAt).toBe(5000 + 3 * 24 * 3600_000);
  });
});
