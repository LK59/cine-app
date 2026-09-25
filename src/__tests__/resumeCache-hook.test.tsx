// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { SWRConfig } from "swr";
import { RESUME_KEY, NEXT_UP_KEY } from "@/lib/swr";

vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ session: null }) }));

/**
 * Monté par la page du cinéma *avant* le cinéma lui-même — qui attend encore le catalogue gardé sur
 * l'appareil. Un `useSWR` qui demandait « Reprendre » au serveur prenait alors la clé, et
 * l'hydratation, qui ne touche jamais une clé déjà demandée, laissait la rangée sans son affichage
 * instantané (25/09/2026). L'orchestrateur ne fait que lire.
 */
afterEach(() => vi.unstubAllGlobals());

describe("l'orchestrateur de la reprise instantanée", () => {
  it("ne demande ni « Reprendre » ni « À suivre », et ne prend pas leur place dans le cache", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cache = new Map();
    const { useResumeCache } = await import("@/lib/resumeCache/useResumeCache");
    function Probe() {
      useResumeCache();
      return null;
    }
    render(
      <SWRConfig value={{ provider: () => cache }}>
        <Probe />
      </SWRConfig>
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cache.get(RESUME_KEY)?.isValidating ?? false).toBe(false);
    expect(cache.get(NEXT_UP_KEY)?.data).toBeUndefined();
  });
});
