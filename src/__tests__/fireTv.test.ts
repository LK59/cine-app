// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { installRemoteDiag, isFireTv } from "@/lib/fireTv";

const SILK = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36";
const PIXEL = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

describe("isFireTv", () => {
  it("reconnaît la Fire TV Stick de Timothé, pas un téléphone Android", () => {
    expect(isFireTv(SILK)).toBe(true);
    expect(isFireTv(PIXEL)).toBe(false);
  });
});

describe("installRemoteDiag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function trustedKey(key: string, keyCode: number): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(e, "keyCode", { value: keyCode });
    return e;
  }

  it("relève les touches telles qu'elles arrivent et n'envoie qu'une fois", () => {
    const send = vi.fn();
    const remove = installRemoteDiag(window, send);
    document.body.dispatchEvent(trustedKey("ArrowDown", 40));
    document.body.dispatchEvent(trustedKey("", 13));
    vi.advanceTimersByTime(90_000);
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0][0] as { keys: { key: string; keyCode: number }[] };
    expect(body.keys.map((k) => [k.key, k.keyCode])).toEqual([
      ["ArrowDown", 40],
      ["", 13],
    ]);
    // Une fois par onglet : un second relevé ne repart pas.
    const again = vi.fn();
    installRemoteDiag(window, again)();
    document.body.dispatchEvent(trustedKey("ArrowDown", 40));
    vi.advanceTimersByTime(90_000);
    expect(again).not.toHaveBeenCalled();
    remove();
  });

  it("n'envoie rien s'il ne s'est rien passé", () => {
    const send = vi.fn();
    installRemoteDiag(window, send);
    vi.advanceTimersByTime(90_000);
    expect(send).not.toHaveBeenCalled();
  });
});
