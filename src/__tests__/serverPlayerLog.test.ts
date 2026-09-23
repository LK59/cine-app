import { describe, it, expect } from "vitest";
import { serverStartFields, serverFailureFields, castEstablishedFields } from "@/lib/serverPlayerLog";
import { isPlayerEventKind } from "@/lib/playerLog";

// Le lecteur serveur n'écrivait rien : l'AirPlay figé du 22/09/2026 ne s'est compris qu'au journal
// du relais. Ces lignes doivent se distinguer de celles du lecteur natif et dire par où elles sont
// passées — sans cela, un repli se lit comme une fin de séance.
const CTX = { itemId: "a".repeat(32), title: "Ted Lasso — S01E03", cast: true };

describe("journal du lecteur serveur", () => {
  it("nomme son lecteur et sa voie sur chaque ligne", () => {
    for (const line of [
      serverStartFields(CTX, { directPlay: false, nativeHls: true, resumeAt: 628.7, audioStreamIndex: 1 }),
      serverFailureFields(CTX, "négociation refusée"),
      castEstablishedFields(CTX, 630.2),
    ]) {
      expect(line).toMatchObject({ itemId: CTX.itemId, title: CTX.title, player: "serveur", path: "serveur", cast: true });
    }
  });

  it("dit comment le flux est servi, et d'où il reprend", () => {
    expect(serverStartFields(CTX, { directPlay: false, nativeHls: true, resumeAt: 628.7, audioStreamIndex: 1 })).toMatchObject({
      reason: "transcodé par le serveur",
      hls: "natif",
      at: 628.7,
      audioStreamIndex: 1,
    });
    expect(serverStartFields(CTX, { directPlay: true, nativeHls: false, resumeAt: undefined, audioStreamIndex: undefined })).toMatchObject({
      reason: "fichier servi tel quel",
      hls: "aucun",
      at: 0,
    });
    expect(serverStartFields(CTX, { directPlay: false, nativeHls: false, resumeAt: 0, audioStreamIndex: undefined }).hls).toBe("hls.js");
  });

  it("n'écrit pas de piste audio ni de titre inconnus", () => {
    const line = serverStartFields({ ...CTX, title: null }, { directPlay: true, nativeHls: true, resumeAt: 0, audioStreamIndex: undefined });
    expect(line).not.toHaveProperty("title");
    expect(line).not.toHaveProperty("audioStreamIndex");
  });

  it("garde les détails d'un échec", () => {
    expect(serverFailureFields(CTX, "négociation refusée", { status: 409, code: "cast-refused" })).toMatchObject({
      reason: "négociation refusée",
      status: 409,
      code: "cast-refused",
    });
  });

  it("dit qu'une diffusion est établie, et à quelle position", () => {
    expect(castEstablishedFields(CTX, 630.6)).toMatchObject({ reason: "diffusion établie", at: 631 });
  });

  it("est accepté par le journal", () => {
    // Un genre refusé par la route serait une ligne perdue sans un mot, côté navigateur.
    expect(isPlayerEventKind("cast")).toBe(true);
  });
});
