// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LoginBackdrop, LoginBackgroundProvider } from "@/components/login/LoginBackdrop";

// DECISIONS §199 : l'image vient du serveur par le contexte ; sans elle, l'écran reste noir.
describe("le fond des écrans de connexion", () => {
  it("rien sans image", () => {
    const { container } = render(<LoginBackdrop />);
    expect(container.querySelector("[data-login-backdrop]")).toBeNull();
  });

  it("l'image sous le contenu, à son adresse versionnée, avec son voile", () => {
    const { container } = render(
      <LoginBackgroundProvider value={{ v: "0123456789ab", dim: 40 }}>
        <LoginBackdrop />
      </LoginBackgroundProvider>,
    );
    const layer = container.querySelector("[data-login-backdrop]")!;
    expect(layer.className).toContain("-z-10");
    expect(layer.querySelector("img")!.getAttribute("src")).toBe("/api/login-background?v=0123456789ab");
    expect((layer.querySelector(".bg-black") as HTMLElement).style.opacity).toBe("0.4");
  });
});
