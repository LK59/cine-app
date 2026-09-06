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

describe("statusHistoryDb — l'historique des services", () => {
  it("agrège la latence et les échecs de chaque service sur une fenêtre", () => {
    const now = Date.now();
    db.statusHistoryDb.recordServiceChecks(
      { radarr: { status: "ok", latencyMs: 10 }, sonarr: { status: "down", latencyMs: null } },
      now - 1000
    );
    db.statusHistoryDb.recordServiceChecks(
      { radarr: { status: "ok", latencyMs: 30 }, sonarr: { status: "ok", latencyMs: 50 } },
      now - 500
    );

    const stats = db.statusHistoryDb.getServiceLatencyStats(now - 10_000);
    const radarr = stats.find((s) => s.service === "radarr")!;
    const sonarr = stats.find((s) => s.service === "sonarr")!;

    expect(radarr).toMatchObject({ samples: 2, avgMs: 20, maxMs: 30, failures: 0 });
    // Un relevé sans latence ne compte pas dans la moyenne, mais compte comme échec.
    expect(sonarr).toMatchObject({ samples: 2, avgMs: 50, maxMs: 50, failures: 1 });
  });

  it("ignore ce qui est hors de la fenêtre", () => {
    const now = Date.now();
    db.statusHistoryDb.recordServiceChecks({ vieux: { status: "ok", latencyMs: 5 } }, now - 60_000);
    expect(db.statusHistoryDb.getServiceLatencyStats(now - 1000).map((s) => s.service)).not.toContain("vieux");
  });

  it("rend une moyenne nulle, et non zéro, pour un service jamais joignable", () => {
    const now = Date.now();
    db.statusHistoryDb.recordServiceChecks({ muet: { status: "down", latencyMs: null } }, now - 100);
    const stat = db.statusHistoryDb.getServiceLatencyStats(now - 10_000).find((s) => s.service === "muet")!;
    expect(stat.avgMs).toBeNull();
    expect(stat.failures).toBe(1);
  });

  it("le ménage se positionne par la date au lieu de balayer tout l'index", () => {
    // La faute d'origine : les deux index commencent par le nom du service, donc une suppression
    // « tout ce qui est plus vieux que X » parcourait le million d'entrées — et better-sqlite3
    // étant synchrone, elle tenait la boucle d'événements pendant tout ce temps.
    const plan = db
      .getDb()
      .prepare("EXPLAIN QUERY PLAN SELECT rowid FROM capability_checks WHERE checked_at < ?")
      .all(Date.now()) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/SEARCH/);
  });

  it("supprime au-delà de la rétention et garde le reste", () => {
    const now = Date.now();
    db.statusHistoryDb.recordCapabilityChecks([{ id: "ancien", status: "ok" }], now - 20 * 24 * 3600_000);
    db.statusHistoryDb.recordCapabilityChecks([{ id: "recent", status: "ok" }], now - 1000);
    db.statusHistoryDb.cleanup(10 * 24 * 3600_000);
    expect(db.statusHistoryDb.getCapabilityHistory("ancien", 0)).toHaveLength(0);
    expect(db.statusHistoryDb.getCapabilityHistory("recent", 0)).toHaveLength(1);
  });
});

describe("le ménage par tranches", () => {
  it("efface un retard qui dépasse largement une tranche", () => {
    const old = Date.now() - 30 * 24 * 3600_000;
    // Plus que CLEANUP_BATCH (5 000), donc plusieurs tours de boucle : c'est le cas d'une
    // rétention qu'on vient de raccourcir, ou d'une application arrêtée trois semaines.
    const rows = Array.from({ length: 12_000 }, (_, i) => ({ id: `retard-${i % 3}`, status: "ok" }));
    for (let i = 0; i < 4; i++) db.statusHistoryDb.recordCapabilityChecks(rows.slice(0, 3000), old + i);

    db.statusHistoryDb.cleanup(10 * 24 * 3600_000);

    for (const id of ["retard-0", "retard-1", "retard-2"]) {
      expect(db.statusHistoryDb.getCapabilityHistory(id, 0)).toHaveLength(0);
    }
  });
});
