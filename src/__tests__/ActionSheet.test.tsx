// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function actions(overrides: Partial<SheetAction> = {}): SheetAction[] {
  return [{ label: "Do thing", onClick: vi.fn(), ...overrides }];
}

describe("ActionSheet", () => {
  it("renders nothing when closed", () => {
    render(<ActionSheet open={false} onClose={vi.fn()} actions={actions()} />);
    expect(screen.queryByText("Do thing")).not.toBeInTheDocument();
  });

  it("renders the title, subtitle, and actions when open", () => {
    render(
      <ActionSheet
        open
        onClose={vi.fn()}
        title="A Movie"
        subtitle="2024"
        actions={actions()}
      />
    );
    expect(screen.getByText("A Movie")).toBeInTheDocument();
    expect(screen.getByText("2024")).toBeInTheDocument();
    expect(screen.getByText("Do thing")).toBeInTheDocument();
  });

  it("calls the action's onClick and then onClose when an action is clicked", async () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<ActionSheet open onClose={onClose} actions={actions({ onClick })} />);

    await user.click(screen.getByText("Do thing"));

    expect(onClick).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("does not fire a disabled action's onClick", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<ActionSheet open onClose={vi.fn()} actions={actions({ onClick, disabled: true })} />);

    await user.click(screen.getByText("Do thing"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ActionSheet open onClose={onClose} actions={actions()} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ActionSheet open onClose={onClose} actions={actions()} />);

    // ActionSheet renders via createPortal(document.body) — not inside the render container.
    // First child of the fixed-inset wrapper is the backdrop div.
    const backdrop = document.body.querySelector(".fixed.inset-0 > div")!;
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("stays mounted through the exit animation after `open` flips to false", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<ActionSheet open onClose={vi.fn()} actions={actions()} />);
    expect(screen.getByText("Do thing")).toBeInTheDocument();

    rerender(<ActionSheet open={false} onClose={vi.fn()} actions={actions()} />);
    // Still in the DOM right after the flip — unmount is deferred for the exit transition.
    expect(screen.getByText("Do thing")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("Do thing")).not.toBeInTheDocument();
  });
});
