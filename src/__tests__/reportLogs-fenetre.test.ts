import { describe, it, expect, beforeEach, vi } from "vitest";

// Un dossier de journaux à ce fichier seul : les fichiers de test tournent en parallèle.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-reportlogs-`);
});
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "@/lib/logFile";
import { __testing as reader } from "@/lib/activity/logReader";
import { captureReportLogs } from "@/lib/reportLogs";

const DAY = 24 * 60 * 60 * 1000;

// `readRecords` rend en entier la génération qui chevauche `since` : un auth.log tout neuf (mtime
// d'aujourd'hui) qui remonte à un mois était figé tel quel dans le ticket, connexions d'il y a
// trente jours comprises, au lieu des sept derniers jours annoncés.
describe("un signalement ne fige que les sept derniers jours de connexions et de notifications", () => {
  beforeEach(() => {
    reader.reset();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const f of fs.readdirSync(LOG_DIR)) fs.rmSync(path.join(LOG_DIR, f));
  });

  const write = (name: string, lines: object[]) =>
    fs.writeFileSync(path.join(LOG_DIR, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  it("auth.log : les lignes vieilles de trente jours restent dehors", () => {
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago).toISOString();
    write("auth.log", [
      { timestamp: at(30 * DAY), kind: "login", user: "alice", note: "vieille" },
      { timestamp: at(10 * DAY), kind: "login", user: "alice", note: "vieille" },
      { timestamp: at(2 * DAY), kind: "login", user: "alice", note: "recente" },
      { timestamp: at(60_000), kind: "logout", user: "alice", note: "recente" },
    ]);
    const { auth } = captureReportLogs("alice", { id: null, title: null }, now);
    expect(auth.map((l) => l.note)).toEqual(["recente", "recente"]);
  });

  it("notifications.log : même fenêtre", () => {
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago).toISOString();
    write("notifications.log", [
      { timestamp: at(30 * DAY), kind: "sent", note: "vieille", recipients: [{ user: "alice", status: "delivered" }] },
      { timestamp: at(DAY), kind: "sent", note: "recente", recipients: [{ user: "alice", status: "delivered" }] },
    ]);
    const { notifications } = captureReportLogs("alice", { id: null, title: null }, now);
    expect(notifications.map((l) => l.note)).toEqual(["recente"]);
  });
});
