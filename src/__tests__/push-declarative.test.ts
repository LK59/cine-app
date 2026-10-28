import { describe, it, expect, vi, beforeEach } from "vitest";

// Une vraie base SQLite, à ce fichier seul.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-push-declarative-`);
});

const sendWebPush = vi.fn(async () => {});
vi.mock("@/lib/webPush", () => ({
  isWebPushConfigured: () => true,
  sendWebPush: (...a: unknown[]) => sendWebPush(...(a as [])),
  shouldRemovePushSubscription: () => false,
}));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getUsers: async () => [] } }));
vi.mock("@/lib/eventLogs", () => ({ logNotificationSent: () => {} }));

/**
 * La notification déclarative (28/10/2026) : un abonnement dont on connaît le site reçoit, en plus des
 * champs d'avant, la forme que Safari 18.4+ affiche lui-même si le service worker ne le fait pas —
 * avec l'adresse complète de son site. Un abonnement sans site connu reçoit exactement l'ancien message.
 */

import { pushOrigin } from "@/lib/pushEndpoint";
import { declarativePush } from "@/lib/push";

describe("le site d'un abonnement", () => {
  it("une origine nue en HTTPS, ou en HTTP en local", () => {
    expect(pushOrigin("https://app.laterna.fr")).toBe("https://app.laterna.fr");
    expect(pushOrigin("http://localhost:3001")).toBe("http://localhost:3001");
  });

  it("rien d'autre", () => {
    for (const bad of [null, "", "null", "http://app.laterna.fr", "https://app.laterna.fr/chemin", "javascript:alert(1)", "https://user:pw@app.laterna.fr"]) {
      expect(pushOrigin(bad)).toBeNull();
    }
  });
});

describe("la forme déclarative", () => {
  it("garde les champs d'avant, et ajoute ce que le système sait afficher", () => {
    const m = declarativePush({ title: "Dune", body: "Votre demande est disponible", url: "/#film=42", tag: "dispo" }, "https://app.laterna.fr", "fr");
    expect(m).toMatchObject({ title: "Dune", body: "Votre demande est disponible", url: "/#film=42", tag: "dispo" });
    expect(m.web_push).toBe(8030);
    expect(m.mutable).toBe(true);
    expect(m.notification).toEqual({ title: "Dune", body: "Votre demande est disponible", navigate: "https://app.laterna.fr/#film=42", tag: "dispo", lang: "fr", silent: false });
  });

  it("une adresse qui sortirait du site ramène à son accueil", () => {
    const m = declarativePush({ title: "t", body: "b", url: "https://ailleurs.example/x" }, "https://app.laterna.fr", null);
    expect(m.notification.navigate).toBe("https://app.laterna.fr/");
    expect(m.notification).not.toHaveProperty("lang");
  });
});

describe("l'envoi", () => {
  beforeEach(() => sendWebPush.mockClear());

  it("site connu : la forme déclarative ; inconnu : l'ancien message, tel quel", async () => {
    const { pushDb } = await import("@/lib/db");
    const { sendPushToUser } = await import("@/lib/push");
    pushDb.upsert("alice", "https://web.push.apple.com/connu", "p", "a", "fr", "https://app.laterna.fr");
    pushDb.upsert("alice", "https://web.push.apple.com/ancien", "p", "a", "fr");
    await sendPushToUser("alice", { title: "t", body: "b", url: "/" });
    const sent = new Map(sendWebPush.mock.calls.map((c) => [(c as unknown as [{ endpoint: string }, Record<string, unknown>])[0].endpoint, (c as unknown as [unknown, Record<string, unknown>])[1]]));
    expect(sent.get("https://web.push.apple.com/connu")).toMatchObject({ web_push: 8030, notification: { navigate: "https://app.laterna.fr/" } });
    expect(sent.get("https://web.push.apple.com/ancien")).not.toHaveProperty("web_push");
  });

  it("un site connu n'est pas effacé par un envoi d'abonnement qui n'en dit rien", async () => {
    const { pushDb } = await import("@/lib/db");
    pushDb.upsert("bob", "https://web.push.apple.com/b", "p", "a", null, "https://app.laterna.fr");
    pushDb.upsert("bob", "https://web.push.apple.com/b", "p", "a", null, null);
    expect(pushDb.getByUser("bob")[0].origin).toBe("https://app.laterna.fr");
  });
});
