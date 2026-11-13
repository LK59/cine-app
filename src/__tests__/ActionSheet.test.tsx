// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionSheet, type SheetAction } from "@/components/ActionSheet";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function actions(overrides: Partial<SheetAction> = {}): SheetAction[] {
  return [{ label: "Do thing", onClick: vi.fn(), ...overrides }];
}

describe("ActionSheet", () => {
  // Une confirmation ne s'ouvre pas sur son geste destructeur : Entrée pressée juste après
  // l'ouverture supprimait la demande (08/10/2026).
  it("une confirmation donne le focus à l'action sans danger", async () => {
    render(
      <ActionSheet
        open
        role="alertdialog"
        onClose={vi.fn()}
        actions={[
          { label: "Oui, annuler", variant: "danger", onClick: vi.fn() },
          { label: "Non, garder", onClick: vi.fn() },
        ]}
      />
    );
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Non, garder"));
  });

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

  it("rouverte juste après une fermeture au doigt, elle remonte bien", () => {
    // 23/09/2026 : la fermeture au doigt laissait son décalage écrit sur l'élément, qui reste monté
    // 300 ms pour sa sortie. Rouverte dans ce délai, la feuille gardait ce style en ligne, plus fort que
    // la classe qui devait la faire remonter : le fond s'affichait, pas elle. Depuis le 13/11/2026, une
    // carte neuve à chaque ouverture.
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(<ActionSheet open onClose={onClose} actions={actions()} />);
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const handle = sheet.firstElementChild as HTMLElement;
    drag(handle, [100, 300], 300);
    expect(onClose).toHaveBeenCalled();
    expect(sheet.style.transform).toBe(`translateY(${window.innerHeight}px)`);
    rerender(<ActionSheet open={false} onClose={onClose} actions={actions()} />);
    act(() => void vi.advanceTimersByTime(100));
    rerender(<ActionSheet open onClose={onClose} actions={actions()} />);
    expect(document.querySelector<HTMLElement>('[role="dialog"]')!.style.transform).toBe("");
  });
});

/**
 * Le glisser vers le bas (13/11/2026) : le geste des fiches (`useSwipeToDismiss`), depuis toute la feuille et
 * non plus sa seule poignée — Louis n'arrivait pas à descendre la fenêtre « Détails » au téléphone.
 */
describe("ActionSheet — le glisser vers le bas", () => {
  afterEach(() => vi.restoreAllMocks());

  const sheetWith = (onClose: () => void, children: React.ReactNode) =>
    render(
      <ActionSheet open onClose={onClose} actions={actions()} ariaLabel="Détails">
        {children}
      </ActionSheet>
    );

  it("la feuille suit le doigt depuis son contenu, et se ferme au-delà du seuil", () => {
    const onClose = vi.fn();
    sheetWith(onClose, <div data-testid="corps">Image</div>);
    const sheet = screen.getByRole("dialog");
    const body = screen.getByTestId("corps");
    // La première tolérance est retranchée (30 px), puis la carte suit le doigt pixel pour pixel.
    press(body, "pointerdown", 100, 0);
    press(body, "pointermove", 130, 100);
    press(body, "pointermove", 180, 200);
    expect(sheet.style.transform).toBe("translateY(50px)");
    press(body, "pointermove", 330, 300);
    expect(sheet.style.transform).toBe("translateY(200px)");
    press(body, "pointerup", 330, 1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("revient en place en deçà du seuil, sans fermer", () => {
    const onClose = vi.fn();
    sheetWith(onClose, <div data-testid="corps">Image</div>);
    const sheet = screen.getByRole("dialog");
    const body = screen.getByTestId("corps");
    press(body, "pointerdown", 100, 0);
    press(body, "pointermove", 110, 100);
    press(body, "pointermove", 190, 500);
    expect(sheet.style.transform).toBe("translateY(80px)");
    press(body, "pointerup", 190, 2000);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe("translateY(0px)");
  });

  it("ni depuis un bouton, ni depuis un contenu qui défile", () => {
    const onClose = vi.fn();
    sheetWith(
      onClose,
      <div data-sheet-scroll="" data-testid="liste">
        <p data-testid="ligne">Son</p>
      </div>
    );
    const sheet = screen.getByRole("dialog");
    // Un contenu qui dépasse : le doigt y fait défiler.
    const list = screen.getByTestId("liste");
    let height = 900;
    Object.defineProperty(list, "scrollHeight", { get: () => height });
    Object.defineProperty(list, "clientHeight", { value: 300 });
    drag(screen.getByTestId("ligne"), [100, 400], 400);
    drag(screen.getByRole("button", { name: "Do thing" }), [100, 400], 400);
    expect(sheet.style.transform).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    // Le même contenu qui tient tout se tire comme le reste.
    height = 300;
    drag(screen.getByTestId("ligne"), [100, 400], 400);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/** Un événement de pointeur à `clientY`, l'horloge du geste posée à `at` ms. */
function press(el: Element, type: string, clientY: number, at: number) {
  vi.spyOn(performance, "now").mockReturnValue(at);
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY })));
}

/** Un glissement lent par ces positions, relâché à `end` — une seconde par étape, jamais un geste vif. */
function drag(el: Element, path: number[], end: number) {
  path.forEach((y, i) => press(el, i === 0 ? "pointerdown" : "pointermove", y, i * 1000));
  press(el, "pointerup", end, path.length * 1000);
}
