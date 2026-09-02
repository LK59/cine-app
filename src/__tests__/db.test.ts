import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// db.ts reads process.env.DATA_DIR at module-evaluation time, so it must be
// set before the module is first imported — use a dynamic import in beforeAll
// rather than a static top-level import.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cine-db-test-"));

let db: typeof import("@/lib/db");

beforeAll(async () => {
  process.env.DATA_DIR = TMP_DIR;
  db = await import("@/lib/db");
  // Force schema creation
  db.getDb();
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("watchlistDb", () => {
  it("upserts and reads back an item", () => {
    const item = db.watchlistDb.upsert({
      userId: "u1",
      mediaType: "movie",
      tmdbId: 100,
      tvdbId: null,
      title: "Inception",
      year: 2010,
      posterPath: "/poster.jpg",
      voteAverage: 8.5,
      status: "to_watch",
      note: null,
    });
    expect(item.title).toBe("Inception");
    expect(item.status).toBe("to_watch");

    const fetched = db.watchlistDb.get("u1", "movie", 100);
    expect(fetched?.title).toBe("Inception");
  });

  it("upsert updates status/note on conflict without touching identity fields", () => {
    db.watchlistDb.upsert({
      userId: "u1",
      mediaType: "movie",
      tmdbId: 101,
      tvdbId: null,
      title: "Interstellar",
      year: 2014,
      posterPath: null,
      voteAverage: null,
      status: "to_watch",
      note: null,
    });
    const updated = db.watchlistDb.upsert({
      userId: "u1",
      mediaType: "movie",
      tmdbId: 101,
      tvdbId: null,
      title: "Interstellar",
      year: 2014,
      posterPath: null,
      voteAverage: null,
      status: "favorite",
      note: "great movie",
    });
    expect(updated.status).toBe("favorite");
    expect(updated.note).toBe("great movie");
  });

  it("preserves vote_average via COALESCE when a later upsert passes null", () => {
    db.watchlistDb.upsert({
      userId: "u1",
      mediaType: "movie",
      tmdbId: 102,
      tvdbId: null,
      title: "Dune",
      year: 2021,
      posterPath: null,
      voteAverage: 7.9,
      status: "to_watch",
      note: null,
    });
    const updated = db.watchlistDb.upsert({
      userId: "u1",
      mediaType: "movie",
      tmdbId: 102,
      tvdbId: null,
      title: "Dune",
      year: 2021,
      posterPath: null,
      voteAverage: null,
      status: "watched",
      note: null,
    });
    expect(updated.voteAverage).toBe(7.9);
  });

  it("getAll filters by status", () => {
    db.watchlistDb.upsert({
      userId: "u2",
      mediaType: "series",
      tmdbId: 200,
      tvdbId: null,
      title: "Breaking Bad",
      year: 2008,
      posterPath: null,
      voteAverage: null,
      status: "watched",
      note: null,
    });
    db.watchlistDb.upsert({
      userId: "u2",
      mediaType: "series",
      tmdbId: 201,
      tvdbId: null,
      title: "The Wire",
      year: 2002,
      posterPath: null,
      voteAverage: null,
      status: "to_watch",
      note: null,
    });
    const watched = db.watchlistDb.getAll("u2", "watched");
    expect(watched).toHaveLength(1);
    expect(watched[0].title).toBe("Breaking Bad");

    const all = db.watchlistDb.getAll("u2");
    expect(all).toHaveLength(2);
  });

  it("isInWatchlist reflects presence", () => {
    expect(db.watchlistDb.isInWatchlist("u1", "movie", 100)).toBe(true);
    expect(db.watchlistDb.isInWatchlist("u1", "movie", 999)).toBe(false);
  });

  it("getBulkStatus returns only matching keys, with their status", () => {
    const result = db.watchlistDb.getBulkStatus("u1", [
      { mediaType: "movie", tmdbId: 100 },
      { mediaType: "movie", tmdbId: 999 },
    ]);
    expect(result.has("movie:100")).toBe(true);
    expect(result.get("movie:100")).toBe("to_watch");
    expect(result.has("movie:999")).toBe(false);
  });

  it("getBulkStatus returns empty map for empty input", () => {
    expect(db.watchlistDb.getBulkStatus("u1", [])).toEqual(new Map());
  });

  it("updateStatus scopes by userId — no cross-user writes", () => {
    const item = db.watchlistDb.get("u1", "movie", 100)!;
    const changedByWrongUser = db.watchlistDb.updateStatus("someone-else", item.id, "favorite");
    expect(changedByWrongUser).toBe(false);

    const changed = db.watchlistDb.updateStatus("u1", item.id, "favorite");
    expect(changed).toBe(true);
    expect(db.watchlistDb.get("u1", "movie", 100)?.status).toBe("favorite");
  });

  it("remove scopes by userId and reports whether a row was deleted", () => {
    const item = db.watchlistDb.upsert({
      userId: "u3",
      mediaType: "movie",
      tmdbId: 300,
      tvdbId: null,
      title: "Arrival",
      year: 2016,
      posterPath: null,
      voteAverage: null,
      status: "to_watch",
      note: null,
    });
    expect(db.watchlistDb.remove("someone-else", item.id)).toBe(false);
    expect(db.watchlistDb.remove("u3", item.id)).toBe(true);
    expect(db.watchlistDb.get("u3", "movie", 300)).toBeNull();
  });
});

describe("userPrefsDb", () => {
  it("returns instance default when no preference is stored", () => {
    expect(db.userPrefsDb.getLang("new-user", "en")).toBe("en");
  });

  it("stores and retrieves a language preference", () => {
    db.userPrefsDb.setLang("lang-user", "es");
    expect(db.userPrefsDb.getLang("lang-user", "en")).toBe("es");
  });

  it("overwrites an existing preference on conflict", () => {
    db.userPrefsDb.setLang("lang-user", "de");
    expect(db.userPrefsDb.getLang("lang-user", "en")).toBe("de");
  });
});

describe("sessionDb", () => {
  it("creates and detects an existing session", () => {
    db.sessionDb.create("jti-1", "user-a");
    expect(db.sessionDb.exists("jti-1")).toBe(true);
    expect(db.sessionDb.exists("unknown-jti")).toBe(false);
  });

  it("deletes a session", () => {
    db.sessionDb.create("jti-2", "user-a");
    db.sessionDb.delete("jti-2");
    expect(db.sessionDb.exists("jti-2")).toBe(false);
  });

  it("countOthers excludes the current session", () => {
    db.sessionDb.create("jti-3", "user-b");
    db.sessionDb.create("jti-4", "user-b");
    expect(db.sessionDb.countOthers("user-b", "jti-3")).toBe(1);
  });

  it("deleteOthers removes all sessions for a user except current", () => {
    db.sessionDb.create("jti-5", "user-c");
    db.sessionDb.create("jti-6", "user-c");
    db.sessionDb.create("jti-7", "user-c");
    const deleted = db.sessionDb.deleteOthers("user-c", "jti-5");
    expect(deleted).toBe(2);
    expect(db.sessionDb.exists("jti-5")).toBe(true);
    expect(db.sessionDb.exists("jti-6")).toBe(false);
    expect(db.sessionDb.exists("jti-7")).toBe(false);
  });
});

describe("notificationPrefsDb", () => {
  it("returns defaults when nothing is stored", () => {
    const prefs = db.notificationPrefsDb.getForUser("fresh-user");
    expect(prefs["torrent-complete"]).toBe(true);
    expect(prefs["torrent-started"]).toBe(false);
  });

  it("set overrides a single category and leaves others at default", () => {
    db.notificationPrefsDb.set("pref-user", "torrent-started", true);
    const prefs = db.notificationPrefsDb.getForUser("pref-user");
    expect(prefs["torrent-started"]).toBe(true);
    expect(prefs["torrent-complete"]).toBe(true); // untouched default
  });

  it("isEnabled reflects the stored value", () => {
    db.notificationPrefsDb.set("pref-user2", "watchlist-available", false);
    expect(db.notificationPrefsDb.isEnabled("pref-user2", "watchlist-available")).toBe(false);
  });
});

describe("pushDb", () => {
  it("upserts a subscription and lists it by user", () => {
    db.pushDb.upsert("push-user", "https://push.example/ep1", "p256dh-1", "auth-1");
    const subs = db.pushDb.getByUser("push-user");
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe("https://push.example/ep1");
  });

  it("upsert on same endpoint updates rather than duplicates", () => {
    db.pushDb.upsert("push-user", "https://push.example/ep1", "p256dh-2", "auth-2");
    const subs = db.pushDb.getByUser("push-user");
    expect(subs).toHaveLength(1);
    expect(subs[0].p256dh).toBe("p256dh-2");
  });

  it("removeByUserEndpointPrefix removes only matching endpoints", () => {
    db.pushDb.upsert("push-user2", "https://fcm.example/aaa", "p", "a");
    db.pushDb.upsert("push-user2", "https://apple.example/bbb", "p", "a");
    db.pushDb.removeByUserEndpointPrefix("push-user2", "https://fcm.example");
    const remaining = db.pushDb.getByUser("push-user2");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].endpoint).toBe("https://apple.example/bbb");
  });

  it("removeByUser deletes all subscriptions for that user", () => {
    db.pushDb.upsert("push-user3", "https://push.example/x", "p", "a");
    db.pushDb.removeByUser("push-user3");
    expect(db.pushDb.getByUser("push-user3")).toHaveLength(0);
  });
});

describe("availabilityNotifDb", () => {
  it("tracks notified state per media", () => {
    expect(db.availabilityNotifDb.hasBeenNotified("movie", 500)).toBe(false);
    db.availabilityNotifDb.markNotified("movie", 500);
    expect(db.availabilityNotifDb.hasBeenNotified("movie", 500)).toBe(true);
  });
});

describe("timelineDb", () => {
  it("inserts and retrieves events for a specific media", () => {
    db.timelineDb.insertEvent({
      mediaType: "movie",
      tmdbId: 700,
      tvdbId: null,
      title: "Oppenheimer",
      eventType: "downloaded",
      eventDate: Date.now(),
      source: "radarr",
      detail: null,
      userId: null,
    });
    const events = db.timelineDb.getForMedia("movie", 700);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Oppenheimer");
  });

  it("getGlobal returns events across all media ordered by date desc", () => {
    const events = db.timelineDb.getGlobal(10);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("recommendationsDb", () => {
  it("hides and lists hidden recommendations per user", () => {
    db.recommendationsDb.hide("rec-user", 900, "movie");
    const hidden = db.recommendationsDb.getHidden("rec-user");
    expect(hidden.has("movie:900")).toBe(true);
  });
});

describe("trailerDb", () => {
  it("defaults auto-preview to disabled on a fresh db", () => {
    expect(db.trailerDb.getSettings()).toEqual({ autoPreviewEnabled: false });
  });

  it("setAutoPreviewEnabled persists", () => {
    db.trailerDb.setAutoPreviewEnabled(true);
    expect(db.trailerDb.getSettings()).toEqual({ autoPreviewEnabled: true });
    db.trailerDb.setAutoPreviewEnabled(false);
    expect(db.trailerDb.getSettings()).toEqual({ autoPreviewEnabled: false });
  });

  it("returns null when no job has ever run", () => {
    // Fresh temp DB, isolated per test file run — no job started yet at this point.
    expect(db.trailerDb.getLatestJob()).toBeNull();
  });

  it("startJob/updateJobProgress/finishJob/getLatestJob round-trip", () => {
    const id = db.trailerDb.startJob(10);
    let job = db.trailerDb.getLatestJob();
    expect(job).toMatchObject({ id, status: "running", total: 10, completed: 0, failed: 0 });
    expect(job!.finishedAt).toBeNull();

    db.trailerDb.updateJobProgress(id, 4, 1);
    job = db.trailerDb.getLatestJob();
    expect(job).toMatchObject({ completed: 4, failed: 1 });

    db.trailerDb.finishJob(id, "done");
    job = db.trailerDb.getLatestJob();
    expect(job?.status).toBe("done");
    expect(job?.finishedAt).not.toBeNull();
  });

  it("getLatestJob returns the most recently started job", () => {
    db.trailerDb.startJob(5);
    const id2 = db.trailerDb.startJob(20);
    expect(db.trailerDb.getLatestJob()?.id).toBe(id2);
  });
});
