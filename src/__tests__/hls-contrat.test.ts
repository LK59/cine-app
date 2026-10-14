// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import Hls from "hls.js";
import * as hlsModule from "hls.js";
import { HLS_RESET_MEDIA_SOURCE_FLAG, hlsRecoveryPosition, hlsResetItself } from "@/lib/hlsRecovery";

// Le contrat que `PlayerHost` suppose d'hls.js — lu dans les sources de 1.7.3, vérifié ici sur la vraie
// bibliothèque plutôt que sur une imitation (`PlayerHost-hls-recovery.test.tsx` simule hls.js et ne
// peut rien dire d'une montée de version). DECISIONS §67, `hlsRecovery.ts`.

describe("hls.js — le contrat de récupération (vraie bibliothèque)", () => {
  it("la version épinglée est celle que ce contrat décrit", () => {
    expect(Hls.version).toBe("1.7.3");
  });

  it("le drapeau ResetMediaSource recopié vaut celui de la bibliothèque", () => {
    const flags = (hlsModule as unknown as { ErrorActionFlags: Record<string, number> }).ErrorActionFlags;
    expect(flags.ResetMediaSource).toBe(HLS_RESET_MEDIA_SOURCE_FLAG);
  });

  it("MEDIA_SOURCE_REQUIRES_RESET sans variante SDR : hls.js récupère lui-même, déclare la fatale — et notre écouteur passe après", () => {
    const hls = new Hls({ debug: false });
    const order: string[] = [];
    // L'instance, pas le prototype : c'est `this.hls.recoverMediaError()` qu'appelle l'ErrorController.
    hls.recoverMediaError = vi.fn(() => void order.push("hls.js : recoverMediaError"));
    const stopLoad = vi.spyOn(hls, "stopLoad");
    let seen: { fatal: boolean; resetByHls: boolean } | null = null;
    // Posé après la construction, comme dans PlayerHost.
    hls.on(Hls.Events.ERROR, (_e, data) => {
      order.push("notre écouteur");
      seen = { fatal: data.fatal, resetByHls: hlsResetItself(data) };
    });
    hls.trigger(Hls.Events.ERROR, {
      type: Hls.ErrorTypes.MEDIA_ERROR,
      details: Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET,
      fatal: false,
      error: new Error("MediaSource closed while media attached"),
    });
    expect(order).toEqual(["hls.js : recoverMediaError", "notre écouteur"]);
    expect(seen).toEqual({ fatal: true, resetByHls: true });
    // La fatale arrête le chargement après sa propre récupération : c'est ce que notre `startLoad`
    // explicite défait (sans lui, rien ne repart, ou repart de `config.startPosition`).
    expect(stopLoad).toHaveBeenCalled();
    hls.destroy();
  });

  it("une erreur média fatale ordinaire ne porte pas le drapeau : la récupération reste la nôtre", () => {
    const hls = new Hls({ debug: false });
    hls.recoverMediaError = vi.fn();
    let resetByHls: boolean | null = null;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      resetByHls = hlsResetItself(data);
    });
    hls.trigger(Hls.Events.ERROR, {
      type: Hls.ErrorTypes.MEDIA_ERROR,
      details: Hls.ErrorDetails.BUFFER_APPEND_ERROR,
      fatal: true,
      error: new Error("append"),
    });
    expect(hls.recoverMediaError).not.toHaveBeenCalled();
    expect(resetByHls).toBe(false);
    hls.destroy();
  });

  it("la position de relance : l'élément vivant, sinon avant le détachement, sinon la dernière connue", () => {
    expect(hlsRecoveryPosition({ readyState: 4, currentTime: 812.4 }, 300, 100)).toBe(812.4);
    // hls.js vient de détacher : l'élément est à zéro, sans métadonnées.
    expect(hlsRecoveryPosition({ readyState: 0, currentTime: 0 }, 812.4, 100)).toBe(812.4);
    expect(hlsRecoveryPosition({ readyState: 0, currentTime: 0 }, null, 2400)).toBe(2400);
    expect(hlsRecoveryPosition({ readyState: 0, currentTime: 0 }, null, 0)).toBeNull();
    expect(hlsRecoveryPosition(null, null, undefined)).toBeNull();
  });
});
