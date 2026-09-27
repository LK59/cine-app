import { describe, it, expect } from "vitest";
import { BackgroundWatch, HOLD_AFTER_AWAY_MS, IOS_PAUSE_WINDOW_MS, holdPausedOnReturn, pausedByViewer, rewoundPosition } from "@/lib/backgroundReturn";

/** Verrouillé une minute en plein film, sur un iPhone : WebKit relançait tout seul (25/09/2026). */
const locked = { awayMs: 60_000, playingWhenHidden: true, positionWhenHidden: 4115, positionOnReturn: 4115.2 };

describe("la lecture au retour d'arrière-plan", () => {
  it("attend en pause après une absence de plus de quelques secondes", () => {
    expect(holdPausedOnReturn(locked)).toBe(true);
  });

  it("reprend comme avant après un aller-retour rapide", () => {
    expect(holdPausedOnReturn({ ...locked, awayMs: HOLD_AFTER_AWAY_MS - 1 })).toBe(false);
  });

  it("ne touche pas à un film qui était déjà en pause", () => {
    expect(holdPausedOnReturn({ ...locked, playingWhenHidden: false })).toBe(false);
  });

  it("ne touche pas à une vidéo qui a continué pendant l'absence — image dans l'image", () => {
    expect(holdPausedOnReturn({ ...locked, positionOnReturn: 4175 })).toBe(false);
  });

  it("reprend quelques secondes avant, jamais avant le début", () => {
    expect(rewoundPosition(4115)).toBe(4112);
    expect(rewoundPosition(1)).toBe(0);
  });
});

// L'objet qui retient les allers-retours pour l'hôte natif (étape 5 du découpage, 27/09/2026).
describe("BackgroundWatch", () => {
  const playing = (at: number) => ({ paused: false, currentTime: at });
  const paused = (at: number) => ({ paused: true, currentTime: at });

  it("un verrouillage en plein film : au retour, la lecture attend, 3 s avant", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, playing(4115));
    const hold = watch.show(70_000, 60_000, paused(4115.2));
    expect(hold).toEqual({ until: 72_500, at: 4112.2, since: 70_000 });
    expect(watch.currentHold()).toBe(hold);
  });

  it("un aller-retour rapide : rien à retenir", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, playing(100));
    expect(watch.show(12_000, 2_000, paused(100.1))).toBeNull();
  });

  it("une vidéo en pause au départ : rien à retenir — sauf si la pause était celle d'iOS", () => {
    const byViewer = new BackgroundWatch();
    byViewer.notePaused(5_000, { visible: true, ended: false });
    byViewer.hide(10_000, paused(100));
    expect(byViewer.show(70_000, 60_000, paused(100))).toBeNull();

    // La pause tombe dans la seconde qui précède le départ : iOS suspend la vidéo en verrouillant.
    const byIos = new BackgroundWatch();
    byIos.notePaused(9_500, { visible: true, ended: false });
    byIos.hide(10_000, paused(100));
    expect(byIos.show(70_000, 60_000, paused(100))).not.toBeNull();
  });

  it("une source fermée par iOS laisse l'élément à zéro : on reprend à la position du départ", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, playing(1200));
    expect(watch.show(70_000, 60_000, paused(0))?.at).toBe(1197);
  });

  it("refuse la relance du navigateur pendant 2,5 s, sauf après un geste du spectateur", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, playing(100));
    watch.show(70_000, 60_000, paused(100));
    expect(watch.refusePlay(70_500)).toBe(true);
    watch.noteGesture(71_000);
    expect(watch.refusePlay(71_100)).toBe(false);
    // La retenue est levée : plus rien n'est refusé.
    expect(watch.currentHold()).toBeNull();
  });

  it("passé la fenêtre, la retenue se lève d'elle-même", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, playing(100));
    watch.show(70_000, 60_000, paused(100));
    expect(watch.refusePlay(73_000)).toBe(false);
    expect(watch.currentHold()).toBeNull();
  });

  it("un nouveau départ efface la retenue du retour précédent", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, playing(100));
    watch.show(70_000, 60_000, paused(100));
    watch.hide(80_000, paused(97));
    expect(watch.currentHold()).toBeNull();
  });

  it("donne à la reconstruction la dernière pause du spectateur et le dernier départ", () => {
    const watch = new BackgroundWatch();
    expect(watch.pauseFacts()).toEqual({ viewerPausedAt: null, hiddenAt: null });
    watch.notePaused(5_000, { visible: true, ended: false });
    watch.hide(10_000, paused(100));
    expect(watch.pauseFacts()).toEqual({ viewerPausedAt: 5_000, hiddenAt: 10_000 });
    watch.notePlaying();
    expect(watch.pauseFacts().viewerPausedAt).toBeNull();
    // Une pause page masquée, ou sur un film fini, n'est pas celle du spectateur.
    watch.notePaused(20_000, { visible: false, ended: false });
    watch.notePaused(21_000, { visible: true, ended: true });
    expect(watch.pauseFacts().viewerPausedAt).toBeNull();
  });
});

// Relevé par la relecture de l'étape 5 (27/09/2026) : les pauses du lecteur lui-même, au retour,
// comptaient comme celles du spectateur. Un nouveau verrouillage dans la seconde devenait une
// « pause d'iOS », la vidéo était notée en lecture, et chaque aller-retour reculait encore de 3 s.
describe("les pauses du lecteur pendant une retenue", () => {
  it("ne comptent pas comme celles du spectateur, et un nouveau verrouillage ne recule plus", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, { paused: false, currentTime: 1200 });
    const first = watch.show(70_000, 60_000, { paused: true, currentTime: 1200 });
    expect(first?.at).toBe(1197);
    // Le lecteur met en pause (retour), puis refuse la relance de WebKit : deux pauses à lui.
    watch.notePaused(70_001, { visible: true, ended: false });
    watch.notePaused(70_300, { visible: true, ended: false });
    expect(watch.pauseFacts().viewerPausedAt).toBeNull();
    // Reverrouillé une demi-seconde plus tard, rien n'ayant joué : au retour suivant, pas de recul.
    watch.hide(70_800, { paused: true, currentTime: 1197 });
    expect(watch.show(130_000, 59_200, { paused: true, currentTime: 1197 })).toBeNull();
  });

  it("une pause du spectateur après la retenue compte de nouveau", () => {
    const watch = new BackgroundWatch();
    watch.hide(10_000, { paused: false, currentTime: 100 });
    watch.show(70_000, 60_000, { paused: true, currentTime: 100 });
    // Le spectateur relance d'un geste : la retenue se lève.
    watch.noteGesture(71_000);
    watch.refusePlay(71_000);
    watch.notePaused(80_000, { visible: true, ended: false });
    expect(watch.pauseFacts().viewerPausedAt).toBe(80_000);
  });
});

describe("à qui est la pause — une seule définition", () => {
  it("celle du spectateur si elle précède le départ d'au moins la fenêtre, ou le suit", () => {
    expect(pausedByViewer(null, 10_000)).toBe(false);
    expect(pausedByViewer(5_000, null)).toBe(true);
    expect(pausedByViewer(12_000, 10_000)).toBe(true);
    expect(pausedByViewer(10_000 - IOS_PAUSE_WINDOW_MS, 10_000)).toBe(true);
    expect(pausedByViewer(10_000 - IOS_PAUSE_WINDOW_MS + 1, 10_000)).toBe(false);
  });
});
