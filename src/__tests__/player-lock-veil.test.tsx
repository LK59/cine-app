// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));

import { LOCK_HINT_MS, PlayerLockVeil } from "@/components/playerControls/PlayerLockVeil";

/** L'écran verrouillé (18/11/2026) : tout geste avalé, deux touchers sur le cadenas pour sortir. */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const onUnlock = vi.fn();
  const parentClick = vi.fn();
  const parentTouch = vi.fn();
  const view = render(
    <div onClick={parentClick} onTouchStart={parentTouch} onDoubleClick={parentClick}>
      <PlayerLockVeil onUnlock={onUnlock} />
    </div>
  );
  const veil = view.container.querySelector("[data-player-lock]") as HTMLElement;
  return { onUnlock, parentClick, parentTouch, veil };
}

describe("PlayerLockVeil", () => {
  it("montre comment sortir dès le verrouillage, puis se tait", () => {
    setup();
    expect(screen.getByText("player.lock.hint")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(LOCK_HINT_MS));
    expect(screen.queryByText("player.lock.hint")).toBeNull();
  });
  it("aucun geste ne passe aux commandes dessous", () => {
    const { veil, parentClick, parentTouch } = setup();
    fireEvent.click(veil);
    fireEvent.doubleClick(veil);
    fireEvent.touchStart(veil);
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentTouch).not.toHaveBeenCalled();
  });
  it("un toucher rappelle le cadenas ; deux touchers dessus déverrouillent", () => {
    const { veil, onUnlock, parentClick } = setup();
    act(() => void vi.advanceTimersByTime(LOCK_HINT_MS));
    fireEvent.click(veil);
    fireEvent.click(screen.getByText("player.lock.hint"));
    expect(onUnlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("player.lock.confirm"));
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
  it("le second toucher attendu trop tard : il faut recommencer", () => {
    const { onUnlock } = setup();
    fireEvent.click(screen.getByText("player.lock.hint"));
    act(() => void vi.advanceTimersByTime(LOCK_HINT_MS));
    expect(screen.queryByText("player.lock.confirm")).toBeNull();
    expect(onUnlock).not.toHaveBeenCalled();
  });
});
