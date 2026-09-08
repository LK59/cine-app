// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { SWRProvider } from "@/components/SWRProvider";
import { useLegacyPlayer } from "@/lib/useLegacyPlayer";
import { setWatchingFullScreen } from "@/lib/playbackBusy";

/**
 * Ce que ce banc protège, et ce qu'une première version ne protégeait pas.
 *
 * `PlayerHost` ne rend **rien** tant que la réponse « ancien lecteur ? » est inconnue — son
 * `return null` — et cela vaut pour une séance en cours, pas seulement pour un démarrage. Sur une
 * adresse publique, `useLegacyPlayer` ne pose plus la question : il doit donc s'en souvenir.
 *
 * La première version de ce banc se contentait de **re-rendre** l'arbre avec une autre valeur de
 * `usePathname`, et elle passait — la réponse était retenue par `keepPreviousData`, un état porté
 * par l'instance du hook, qui survit en effet à un nouveau rendu. Aucune navigation réelle ne
 * ressemble à cela : la page d'état s'ouvrait par un `<a>` nu, donc par un déchargement complet du
 * document, et le simple fait qu'un remontage puisse arriver suffisait à perdre la réponse. Le
 * banc modélisait la seule forme de navigation qui ne casse pas.
 *
 * D'où la forme d'aujourd'hui : on **démonte** et on remonte, en gardant le cache SWR d'un montage
 * à l'autre — comme en production, où ce cache est global et n'appartient à aucun montage.
 */

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

function Probe() {
  const { legacy } = useLegacyPlayer();
  return <span data-testid="legacy">{String(legacy)}</span>;
}

/**
 * Le cache est créé une fois par test et partagé par tous les montages de ce test : c'est
 * exactement la portée qu'il a en production (la Map globale de SWR), et c'est ce qui distingue
 * « la réponse survit » de « le composant n'a pas bougé ».
 */
let cache: Map<string, unknown>;
function mount() {
  return render(
    <SWRConfig value={{ provider: () => cache as never }}>
      <SWRProvider>
        <Probe />
      </SWRProvider>
    </SWRConfig>
  );
}

const calls = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

beforeEach(() => {
  pathname.current = "/";
  cache = new Map();
  // Une séance qui occupe l'écran, c'est-à-dire le cas où tout ceci se joue. `SWRProvider`
  // suspend tout dans cet état ; `playerBootstrapOptions` est précisément ce qui exempte cette
  // requête-là, et le banc n'aurait rien prouvé sans lui.
  setWatchingFullScreen(true);
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ legacyPlayer: { enabled: true } }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  setWatchingFullScreen(false);
  vi.restoreAllMocks();
});

describe("useLegacyPlayer sur un chemin public, séance en cours", () => {
  /**
   * Le test qui échouait en production pendant que son prédécesseur passait.
   *
   * Un remontage : nouvelle instance de hook, donc plus rien de ce que l'ancienne retenait. Si la
   * réponse ne vit que dans l'instance, elle est perdue ici — `legacy` repasse à `undefined`,
   * `PlayerHost` rend `null`, et le film s'arrête au moment où l'on ouvre la page d'état.
   */
  it("connaît encore la réponse après un remontage sur une adresse publique", async () => {
    const first = mount();
    await waitFor(() => expect(first.getByTestId("legacy").textContent).toBe("true"));
    first.unmount();

    pathname.current = "/status";
    const second = mount();

    // Immédiatement, sans attendre : il n'y a rien à attendre, la réponse est déjà connue.
    expect(second.getByTestId("legacy").textContent).toBe("true");
  });

  // Et elle est connue sans rien redemander : la page d'état est publique, la question ne s'y pose
  // pas — c'est tout l'objet de la pause.
  it("ne redemande rien en arrivant sur l'adresse publique", async () => {
    const first = mount();
    await waitFor(() => expect(first.getByTestId("legacy").textContent).toBe("true"));
    first.unmount();
    const before = calls();

    pathname.current = "/status";
    mount();
    await Promise.resolve();

    expect(calls()).toBe(before);
  });

  /**
   * La contrainte d'origine, celle qu'il ne faut pas casser en réparant l'autre : sur l'écran de
   * connexion, cette route répond 401 et `errorRetryInterval: 1500` en faisait une requête toutes
   * les secondes et demie tant que quelqu'un tapait son mot de passe.
   */
  it("ne demande rien du tout sur un chemin public sans rien en cache", async () => {
    pathname.current = "/login";
    const { getByTestId } = mount();
    await waitFor(() => expect(getByTestId("legacy").textContent).toBe("undefined"));

    // Le temps que SWR aurait pris pour sa revalidation initiale et son premier réessai.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toBe(0);
  });

  /**
   * Le revers de la pause, et le piège de la clé constante : une clé qui changeait déclenchait une
   * revalidation d'elle-même en quittant `/login`. Une clé en pause ne redemande rien quand la
   * pause se lève — il a fallu le demander explicitement, sans quoi la valeur restait indéfinie
   * après la connexion et le bouton Lire ne faisait rien du tout.
   */
  it("demande la réponse en arrivant sur l'application depuis la connexion", async () => {
    pathname.current = "/login";
    const { rerender, getByTestId } = mount();
    await waitFor(() => expect(getByTestId("legacy").textContent).toBe("undefined"));
    expect(calls()).toBe(0);

    // La connexion : `router.replace("/")`, une navigation client — même arbre, même hook.
    pathname.current = "/";
    rerender(
      <SWRConfig value={{ provider: () => cache as never }}>
        <SWRProvider>
          <Probe />
        </SWRProvider>
      </SWRConfig>
    );

    await waitFor(() => expect(getByTestId("legacy").textContent).toBe("true"));
    expect(calls()).toBe(1);
  });
});
