// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useRef } from "react";
import { useHideOnScroll } from "@/lib/useHideOnScroll";

/** Le crochet mesure au prochain rafraîchissement : les tests doivent le laisser arriver. */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function Bar({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const hidden = useHideOnScroll(enabled);
  return (
    <div>
      <div ref={ref} data-testid="scroller" style={{ overflow: "auto" }} />
      <span data-testid="state">{hidden ? "cachée" : "visible"}</span>
    </div>
  );
}

async function scrollTo(top: number) {
  const scroller = screen.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollTop", { value: top, configurable: true });
  fireEvent.scroll(scroller);
  await nextFrame();
}

const state = () => screen.getByTestId("state").textContent;

afterEach(cleanup);

describe("useHideOnScroll", () => {
  it("starts visible", () => {
    render(<Bar />);
    expect(state()).toBe("visible");
  });

  it("hides on the way down and comes back on the way up", async () => {
    render(<Bar />);
    await scrollTo(300);
    expect(state()).toBe("cachée");
    await scrollTo(200);
    expect(state()).toBe("visible");
  });

  // Le seuil : un doigt qui hésite, ou le rebond élastique d'iOS, ne doit pas faire clignoter la
  // barre à chaque pixel.
  it("ignores a movement too small to be an intention", async () => {
    render(<Bar />);
    await scrollTo(300);
    expect(state()).toBe("cachée");
    await scrollTo(305);
    expect(state()).toBe("cachée");
  });

  // En haut, elle est là quoi qu'il arrive : c'est l'endroit où l'on arrive et où l'on revient.
  it("always shows near the top", async () => {
    render(<Bar />);
    await scrollTo(400);
    expect(state()).toBe("cachée");
    await scrollTo(10);
    expect(state()).toBe("visible");
  });

  // Les événements de défilement ne remontent pas : c'est l'écoute en capture qui permet
  // d'entendre n'importe quelle boîte défilante sans qu'elle ait à se déclarer.
  it("hears a scroller it was never handed", async () => {
    render(<Bar />);
    const stranger = document.createElement("div");
    document.body.appendChild(stranger);
    Object.defineProperty(stranger, "scrollTop", { value: 500, configurable: true });
    fireEvent.scroll(stranger);
    await nextFrame();
    expect(state()).toBe("cachée");
    stranger.remove();
  });

  it("stays out of the way when it is turned off", async () => {
    render(<Bar enabled={false} />);
    await scrollTo(500);
    expect(state()).toBe("visible");
  });
});
