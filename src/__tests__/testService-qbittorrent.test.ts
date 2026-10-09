import { describe, it, expect, vi, afterEach } from "vitest";
import { testService } from "@/lib/settings/testService";

/**
 * Le test de connexion de qBittorrent juge comme le client (09/10/2026) : qBittorrent 5.2 et
 * suivants répondent 204 sans corps et posent `QBT_SID_<port>`. Le test attendait « Ok. » et disait
 * « identifiants refusés » à une installation dont les téléchargements fonctionnaient.
 */
const values: Record<string, string> = { QBITTORRENT_URL: "http://qbit:8080", QBITTORRENT_USERNAME: "admin", QBITTORRENT_PASSWORD: "x" };
const reply = (status: number, body: string, cookie?: string) =>
  vi.stubGlobal("fetch", vi.fn(async () => {
    const headers = new Headers();
    if (cookie) headers.append("set-cookie", cookie);
    return new Response(status === 204 ? null : body, { status, headers });
  }));
afterEach(() => vi.unstubAllGlobals());

describe("le test de qBittorrent", () => {
  it("accepte la réponse de qBittorrent 5.2 : 204, sans corps, avec un cookie de session", async () => {
    reply(204, "", "QBT_SID_8080=abc; HttpOnly; path=/");
    expect(await testService("qbittorrent", (k) => values[k] ?? "")).toMatchObject({ ok: true });
  });

  it("accepte l'ancienne réponse « Ok. »", async () => {
    reply(200, "Ok.", "SID=abc; HttpOnly; path=/");
    expect(await testService("qbittorrent", (k) => values[k] ?? "")).toMatchObject({ ok: true });
  });

  it("refuse « Fails. » sans cookie", async () => {
    reply(200, "Fails.");
    expect(await testService("qbittorrent", (k) => values[k] ?? "")).toMatchObject({ ok: false, detail: "unauthorized" });
  });
});
