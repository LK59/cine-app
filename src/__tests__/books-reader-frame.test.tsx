// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

/**
 * Le lecteur de livres posé sur le cinéma dans un cadre de la même origine (DECISIONS.md §128) : le
 * contrat entre les deux documents — des messages aux clés exactes, acceptés seulement de notre origine
 * et de la fenêtre attendue —, une seule entrée d'historique à l'ouverture, et la fermeture par
 * l'adresse du cinéma (`cinemaClose`), jamais par le cadre.
 */
const mutate = vi.fn();
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate }) }));

import { acceptFromFrame, acceptFromParent, frameMessage, isFramedReader, parentMessage, parseFrameMessage, parseParentMessage, readerFrameUrl, tellCinema } from "@/lib/books/readerFrame";
import { ReaderFrame, openReaderFrame, __testing } from "@/components/books/ReaderFrame";
import { cinemaNavigate, readCinemaRoute } from "@/lib/cinemaRoute";

const ID = "ab".repeat(16);
const OTHER = "cd".repeat(16);

afterEach(() => {
  cleanup();
  __testing.release();
  vi.restoreAllMocks();
  mutate.mockReset();
});
beforeEach(() => {
  window.history.replaceState(null, "", "/#livres=1");
});

describe("les messages", () => {
  it("du cadre : la forme exacte, rien de plus ni de moins", () => {
    for (const kind of ["hello", "ready", "saved", "close"] as const) expect(parseFrameMessage(frameMessage(kind, ID))).toEqual(frameMessage(kind, ID));
    const bad: unknown[] = [
      null,
      undefined,
      "close",
      42,
      [],
      [frameMessage("close", ID)],
      { ...frameMessage("close", ID), extra: 1 },
      { app: "laterna-livres", v: 1, kind: "close" },
      { ...frameMessage("close", ID), app: "autre" },
      { ...frameMessage("close", ID), v: 2 },
      { ...frameMessage("close", ID), kind: "navigate" },
      { ...frameMessage("close", ID), kind: "__proto__" },
      { ...frameMessage("close", ID), book: "../../api" },
      { ...frameMessage("close", ID), book: ID.toUpperCase() },
      { ...frameMessage("close", ID), book: 7 },
      Object.assign(Object.create({ inherited: true }), frameMessage("close", ID)),
      new (class {
        app = "laterna-livres";
        v = 1;
        kind = "close";
        book = ID;
      })(),
    ];
    for (const value of bad) expect(parseFrameMessage(value), JSON.stringify(value) ?? String(value)).toBeNull();
  });

  it("du cinéma : des marges, des nombres finis et bornés", () => {
    const ok = parentMessage({ top: 47, right: 0, bottom: 34, left: 0 });
    expect(parseParentMessage(ok)).toEqual(ok);
    for (const value of [
      { ...ok, top: -1 },
      { ...ok, top: Number.NaN },
      { ...ok, top: Number.POSITIVE_INFINITY },
      { ...ok, top: 10_000 },
      { ...ok, top: "47px" },
      { ...ok, kind: "close" },
      { ...ok, extra: true },
      { app: ok.app, v: ok.v, kind: ok.kind, top: 1, right: 1, bottom: 1 },
      null,
      "insets",
    ])
      expect(parseParentMessage(value), JSON.stringify(value)).toBeNull();
  });

  it("acceptés seulement de notre origine et de la fenêtre attendue", () => {
    const frame = {} as Window;
    const origin = window.location.origin;
    const data = frameMessage("close", ID);
    expect(acceptFromFrame({ origin, source: frame, data }, frame, origin)).toEqual(data);
    expect(acceptFromFrame({ origin: "https://ailleurs.example", source: frame, data }, frame, origin)).toBeNull();
    expect(acceptFromFrame({ origin: "null", source: frame, data }, frame, origin)).toBeNull();
    expect(acceptFromFrame({ origin, source: window, data }, frame, origin)).toBeNull();
    expect(acceptFromFrame({ origin, source: null, data }, frame, origin)).toBeNull();
    expect(acceptFromFrame({ origin, source: frame, data }, null, origin)).toBeNull();
    const insets = parentMessage({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(acceptFromParent({ origin, source: frame, data: insets }, frame, origin)).toEqual(insets);
    expect(acceptFromParent({ origin: "https://ailleurs.example", source: frame, data: insets }, frame, origin)).toBeNull();
    expect(acceptFromParent({ origin, source: window, data: insets }, frame, origin)).toBeNull();
  });

  it("le cadre n'écrit qu'à notre origine, et ne se croit cadre qu'avec le paramètre et un parent", () => {
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    tellCinema("close", ID);
    expect(post).toHaveBeenCalledWith(frameMessage("close", ID), window.location.origin);
    // Ici la page est en haut (pas de parent) : jamais « cadre », même avec le paramètre.
    window.history.replaceState(null, "", "/livres?cadre=1#livre=" + ID + "&lire=1");
    expect(isFramedReader()).toBe(false);
    expect(readerFrameUrl(ID)).toBe(`/livres?cadre=1#livre=${ID}&lire=1`);
  });
});

describe("le cadre posé sur le cinéma", () => {
  function frameNow(): HTMLIFrameElement {
    const frame = document.querySelector<HTMLIFrameElement>("[data-reader-frame] iframe");
    if (!frame) throw new Error("pas de cadre");
    return frame;
  }
  function send(data: unknown, init: { origin?: string; source?: Window | null } = {}) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: init.origin ?? window.location.origin, source: init.source === undefined ? frameNow().contentWindow : init.source }));
    });
  }

  it("l'ouverture pousse une seule entrée, après avoir préparé le cadre ; le cadre est fermé à tout sauf l'essentiel", async () => {
    act(() => cinemaNavigate({ book: ID, reading: false }));
    const before = window.history.length;
    await act(() => openReaderFrame(ID, null));
    expect(window.history.length).toBe(before + 1);
    expect(readCinemaRoute()).toMatchObject({ book: ID, reading: true });
    const frame = frameNow();
    expect(frame.getAttribute("src")).toBe(`/livres?cadre=1#livre=${ID}&lire=1`);
    expect(frame.getAttribute("referrerpolicy")).toBe("same-origin");
    const allow = frame.getAttribute("allow") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "fullscreen"]) expect(allow).toContain(`${feature} 'none'`);
    expect(allow).not.toMatch(/\*|'self'|'src'/);
    expect(frame.hasAttribute("sandbox")).toBe(false);
  });

  it("une fiche refermée pendant que la couverture grandit : rien n'est poussé, le cadre est retiré", async () => {
    act(() => cinemaNavigate({ book: ID, reading: false }));
    const opening = openReaderFrame(ID, null);
    act(() => cinemaNavigate({ book: null }, "replace"));
    const before = window.history.length;
    await act(() => opening);
    expect(window.history.length).toBe(before);
    expect(document.querySelector("[data-reader-frame]")).toBeNull();
  });

  it("refermé par l'adresse du cinéma — seulement sur un message de ce cadre, de notre origine, bien formé", async () => {
    act(() => cinemaNavigate({ book: ID, reading: true }));
    const { rerender } = render(<ReaderFrame key={ID} id={ID} />);
    const frame = frameNow();
    expect(frame.title).toBe("books.reader.frame");
    const back = vi.spyOn(window.history, "back");

    send(frameMessage("close", ID), { source: window });
    send(frameMessage("close", ID), { origin: "https://ailleurs.example" });
    send(frameMessage("close", ID), { source: null });
    send({ ...frameMessage("close", ID), extra: 1 });
    send(frameMessage("close", OTHER));
    send("close");
    expect(back).not.toHaveBeenCalled();
    expect(readCinemaRoute().reading).toBe(true);

    send(frameMessage("close", ID));
    expect(back).toHaveBeenCalledTimes(1);
    // Un second `close` avant le retour : toujours un seul `history.back()` en vol.
    send(frameMessage("close", ID));
    expect(back).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(readCinemaRoute().reading).toBeFalsy());
    rerender(<></>);
  });

  it("`hello` reçoit les marges, `saved` relit la position ; retiré, le cadre part et la position est relue", () => {
    act(() => cinemaNavigate({ book: ID, reading: true }));
    const { unmount } = render(<ReaderFrame key={ID} id={ID} />);
    const frame = frameNow();
    const post = vi.spyOn(frame.contentWindow as Window, "postMessage").mockImplementation(() => {});
    send(frameMessage("hello", ID));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ app: "laterna-livres", kind: "insets" }), window.location.origin);
    expect(parseParentMessage(post.mock.calls[0][0])).not.toBeNull();
    // D'ailleurs : ignoré.
    send(frameMessage("hello", ID), { source: window });
    expect(post).toHaveBeenCalledTimes(1);

    send(frameMessage("saved", ID));
    expect(mutate).toHaveBeenCalledWith("/api/books/home");
    expect(mutate).toHaveBeenCalledWith(`/api/books/${ID}`);
    mutate.mockReset();
    unmount();
    expect(document.querySelector("[data-reader-frame]")).toBeNull();
    expect(mutate).toHaveBeenCalledWith("/api/books/home");
  });

  it("Échap resté au cinéma referme par le même chemin", async () => {
    act(() => cinemaNavigate({ book: ID, reading: true }));
    render(<ReaderFrame key={ID} id={ID} />);
    const back = vi.spyOn(window.history, "back");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(back).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(readCinemaRoute().reading).toBeFalsy());
  });
});
