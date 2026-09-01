// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMiniPlayerDrag, MiniPlayerChrome } from "@/components/MiniPlayer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubViewport(width: number, height: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
}

function pointerEvent(x: number, y: number): React.PointerEvent {
  return {
    clientX: x,
    clientY: y,
    pointerType: "mouse",
    button: 0,
    currentTarget: { setPointerCapture: vi.fn() },
  } as unknown as React.PointerEvent;
}

describe("useMiniPlayerDrag", () => {
  it("defaults to the bottom-right corner, clearing the mobile nav on a narrow viewport", () => {
    stubViewport(400, 800);
    const { result } = renderHook(() => useMiniPlayerDrag(true, vi.fn()));

    expect(result.current.size).toEqual({ width: 304, height: 170 });
    // MARGIN=16 on the right, 88px nav clearance on the bottom (viewport < 768).
    expect(result.current.pos).toEqual({ x: 400 - 304 - 16, y: 800 - 170 - 88 });
  });

  it("uses the larger box and plain 16px margin on a wide viewport", () => {
    stubViewport(1200, 900);
    const { result } = renderHook(() => useMiniPlayerDrag(true, vi.fn()));

    expect(result.current.size).toEqual({ width: 360, height: 202 });
    expect(result.current.pos).toEqual({ x: 1200 - 360 - 16, y: 900 - 202 - 16 });
  });

  it("moves the position by the drag delta, clamped to stay on-screen", () => {
    stubViewport(1200, 900);
    const { result } = renderHook(() => useMiniPlayerDrag(true, vi.fn()));
    const start = result.current.pos;

    act(() => result.current.handlers.onPointerDown(pointerEvent(start.x, start.y)));
    // Default position is already the bottom-right corner, so only leftward/upward movement has
    // room to actually move before hitting a clamp; -5000 on y goes off-screen either way.
    act(() => result.current.handlers.onPointerMove(pointerEvent(start.x - 20, start.y - 5000)));

    // x moved by -20; y is clamped to the top margin (16) since -5000 would go off-screen.
    expect(result.current.pos.x).toBe(start.x - 20);
    expect(result.current.pos.y).toBe(16);
    expect(result.current.isDragging).toBe(true);
  });

  it("counts a near-stationary pointerdown->up as a tap, calling onTap", () => {
    stubViewport(1200, 900);
    const onTap = vi.fn();
    const { result } = renderHook(() => useMiniPlayerDrag(true, onTap));
    const start = result.current.pos;

    act(() => result.current.handlers.onPointerDown(pointerEvent(start.x, start.y)));
    act(() => result.current.handlers.onPointerMove(pointerEvent(start.x + 2, start.y + 1))); // below TAP_THRESHOLD
    act(() => result.current.handlers.onPointerUp({} as React.PointerEvent));

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(result.current.isDragging).toBe(false);
  });

  it("does not call onTap when the pointer moved past the tap threshold", () => {
    stubViewport(1200, 900);
    const onTap = vi.fn();
    const { result } = renderHook(() => useMiniPlayerDrag(true, onTap));
    const start = result.current.pos;

    act(() => result.current.handlers.onPointerDown(pointerEvent(start.x, start.y)));
    act(() => result.current.handlers.onPointerMove(pointerEvent(start.x + 50, start.y)));
    act(() => result.current.handlers.onPointerUp({} as React.PointerEvent));

    expect(onTap).not.toHaveBeenCalled();
  });

  it("re-centers to the default corner when reactivated after being inactive", () => {
    stubViewport(1200, 900);
    const { result, rerender } = renderHook(({ active }) => useMiniPlayerDrag(active, vi.fn()), {
      initialProps: { active: true },
    });
    const start = result.current.pos;

    act(() => result.current.handlers.onPointerDown(pointerEvent(start.x, start.y)));
    act(() => result.current.handlers.onPointerMove(pointerEvent(start.x - 100, start.y - 100)));
    expect(result.current.pos).not.toEqual(start);

    rerender({ active: false });
    rerender({ active: true });

    expect(result.current.pos).toEqual(start);
  });
});

describe("MiniPlayerChrome", () => {
  it("shows the play icon while paused and pause icon while playing", () => {
    const { rerender, container } = render(
      <MiniPlayerChrome title="Some Title" playing={false} onTogglePlay={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.querySelector("svg.lucide-play")).toBeInTheDocument();

    rerender(<MiniPlayerChrome title="Some Title" playing onTogglePlay={vi.fn()} onClose={vi.fn()} />);
    expect(container.querySelector("svg.lucide-pause")).toBeInTheDocument();
  });

  it("calls onTogglePlay and onClose from their respective buttons, not from each other", async () => {
    const onTogglePlay = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MiniPlayerChrome title="Some Title" playing={false} onTogglePlay={onTogglePlay} onClose={onClose} />);

    // Both buttons are icon-only (no accessible name) — DOM order is close (top-right) then
    // play/pause (bottom-left), matching the component's own markup order.
    const [closeButton, playButton] = screen.getAllByRole("button");
    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onTogglePlay).not.toHaveBeenCalled();

    await user.click(playButton);
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("renders the given title", () => {
    render(<MiniPlayerChrome title="My Movie" playing={false} onTogglePlay={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("My Movie")).toBeInTheDocument();
  });
});
