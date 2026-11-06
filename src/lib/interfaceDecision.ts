import { FIRE_TV_MODEL } from "@/lib/deviceLabel";
import { IPAD_SIMULATOR_KEY } from "@/lib/ipadSimulator";

/**
 * L'interface tactile ou l'interface ordinateur — la règle de `useIsMobile`, écrite une fois pour
 * deux lecteurs : le crochet, après l'hydratation, et le script posé dans le HTML du cinéma, avant
 * le premier dessin (06/11/2026).
 *
 * Le serveur ne sait pas quel appareil l'appelle : `useIsMobile` lui répond « ordinateur », et le
 * HTML qu'un iPhone recevait portait le rail du bureau — une pilule au bord gauche, réservant sa
 * bande à gauche du contenu —, remplacé par la barre du bas une fois le code démarré, 0,3 à 1,5 s
 * plus tard selon le journal des ouvertures (`bootMs`). Le script décide avant le premier dessin
 * et le note sur `<html data-ui="touch|desktop">` ; le CSS (`globals.css`, « La marque de
 * l'interface ») cache ce qui ne sert pas et réserve les bonnes bandes jusqu'à l'hydratation.
 *
 * Une requête média CSS seule aurait été fausse : un iPad touché a l'interface tactile malgré sa
 * largeur, une Fire TV l'interface ordinateur malgré son pointeur, le choix Compte → Interface et
 * le simulateur d'iPad de l'administrateur changent la réponse. D'où le partage du *code* et non
 * d'une copie : `readInterfaceFacts` et `decideInterface` sont sérialisées dans le script par
 * `toString()`. **Elles ne doivent donc rien lire hors de leurs paramètres** — ni import, ni
 * constante du module : sérialisées, elles n'emportent pas leur portée, et le script se tairait
 * (son `try` avale l'erreur, la page retombe sur l'interface ordinateur au premier dessin).
 * `interface-mark.test.ts` exécute le script et le compare au crochet, cas par cas.
 */

/** Ce que la règle interroge — passé en paramètre aux deux fonctions sérialisées. */
export const INTERFACE_PROBES = {
  // La ligne `md` de Tailwind, plus un téléphone couché : court *et* touché (voir `useIsMobile`).
  narrow: "(max-width: 767px), (max-height: 500px) and (pointer: coarse)",
  // Un appareil qu'on touche et qu'on ne survole pas — voir `useIsTouch`.
  touch: "(hover: none) and (pointer: coarse)",
  anyCoarse: "(any-pointer: coarse)",
  choiceKey: "cine:interface",
  simulatorKey: IPAD_SIMULATOR_KEY,
  fireTv: FIRE_TV_MODEL.source,
};
export type InterfaceProbes = typeof INTERFACE_PROBES;

export interface InterfaceFacts {
  matchMedia: boolean;
  narrow: boolean;
  touch: boolean;
  anyCoarse: boolean;
  screenMin: number;
  fireTv: boolean;
  simulator: boolean;
  choice: string | null;
}

/**
 * Ce que l'appareil dit de lui. Sérialisée : rien hors de `w` et `p`.
 *
 * Sous le simulateur d'iPad, l'écran n'est jamais étroit : son script (lancé juste avant, même
 * layout) vient de réécrire la méta `viewport` à 1 180 px, et rien ne garantit que `matchMedia` le
 * voie déjà à cet instant. Le crochet, lui, le lit bien après — et y trouve la même réponse (un
 * iPhone couché dessiné sur 1 180 px fait ~545 px de haut, au-dessus du seuil des 500).
 */
export function readInterfaceFacts(w: Window, p: InterfaceProbes): InterfaceFacts {
  const media = typeof w.matchMedia === "function";
  const query = (q: string) => media && w.matchMedia(q).matches;
  const stored = (key: string): string | null => {
    try {
      return w.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const simulator = stored(p.simulatorKey) === "1";
  const ua = (w.navigator && w.navigator.userAgent) || "";
  return {
    matchMedia: media,
    narrow: !simulator && query(p.narrow),
    touch: query(p.touch),
    anyCoarse: query(p.anyCoarse),
    screenMin: w.screen ? Math.min(w.screen.width, w.screen.height) : 0,
    fireTv: ua !== "" && new RegExp(p.fireTv).test(ua),
    simulator,
    choice: stored(p.choiceKey),
  };
}

/**
 * La règle (16/10/2026, voir `useIsMobile`). Sérialisée : rien hors de `f`.
 *
 *  - `canChoose` : le choix Compte → Interface n'est proposé que sur un appareil touché à grand
 *    écran (petit côté ≥ 600 px) ou sous le simulateur, jamais sur une Fire TV ;
 *  - `touch` : un écran étroit a toujours l'interface tactile ; sinon le choix rangé, là où il est
 *    proposé ; sinon tactile si l'appareil est touché, sauf une Fire TV.
 */
export function decideInterface(f: InterfaceFacts): { canChoose: boolean; touch: boolean } {
  const canChoose = f.matchMedia && !f.fireTv && (f.simulator || (f.anyCoarse && f.screenMin >= 600));
  if (f.narrow) return { canChoose, touch: true };
  const choice = canChoose && (f.choice === "touch" || f.choice === "desktop") ? f.choice : "auto";
  if (choice !== "auto") return { canChoose, touch: choice === "touch" };
  return { canChoose, touch: f.touch && !f.fireTv };
}

/** L'attribut de `<html>` que le script pose et que `PlayerShell` tient ensuite à jour. */
export const INTERFACE_MARK = "data-ui";
export type InterfaceMark = "touch" | "desktop";

/**
 * Le script du layout du cinéma, juste après celui du simulateur d'iPad. Silencieux s'il échoue :
 * sans marque, le CSS montre l'interface ordinateur, comme avant.
 */
export function interfaceMarkScript(): string {
  return `(function(){try{var f=(${readInterfaceFacts.toString()})(window,${JSON.stringify(INTERFACE_PROBES)});document.documentElement.setAttribute(${JSON.stringify(INTERFACE_MARK)},(${decideInterface.toString()})(f).touch?"touch":"desktop")}catch(e){}})()`;
}
