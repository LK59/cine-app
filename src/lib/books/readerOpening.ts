import { THEME_COLORS, loadReaderPrefs, resolvedTheme } from "@/lib/books/readerPrefs";

/**
 * L'ouverture du lecteur depuis la fiche (DECISIONS.md §127) : la couverture grandit jusqu'à
 * l'écran entier et devient la première page — la couleur du thème de lecture choisi —, le lecteur
 * paraît dessous. Seuls `transform` et `opacity` bougent, sur un calque à part ; « Réduire les
 * animations » saute tout. Rend une fonction qui retire le calque (le lecteur est là) ; quand la
 * page change de document (l'accueil mène à `/livres`), le calque part avec elle.
 */
const GROW_MS = 380;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export async function readerOpening(cover: HTMLElement | null): Promise<() => void> {
  const noop = () => {};
  if (!cover || typeof document === "undefined" || reducedMotion()) return noop;
  const rect = cover.getBoundingClientRect();
  if (rect.width === 0) return noop;
  let systemDark = true;
  try {
    systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    /* sombre par défaut, comme l'application */
  }
  const page = THEME_COLORS[resolvedTheme(loadReaderPrefs().theme, systemDark)].bg;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.setAttribute("data-reader-opening", "");
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "400", pointerEvents: "none" });
  const sheet = document.createElement("div");
  Object.assign(sheet.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${window.innerWidth}px`,
    height: `${window.innerHeight}px`,
    transformOrigin: "0 0",
    background: page,
    overflow: "hidden",
    borderRadius: "8px",
  });
  const img = cover.querySelector("img")?.cloneNode(false) as HTMLImageElement | undefined;
  if (img) {
    img.removeAttribute("data-sheet-photo");
    Object.assign(img.style, { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover" });
    sheet.appendChild(img);
  }
  layer.appendChild(sheet);
  document.body.appendChild(layer);
  const sx = rect.width / window.innerWidth;
  const sy = rect.height / window.innerHeight;
  const from = `translate(${rect.left}px, ${rect.top}px) scale(${sx}, ${sy})`;
  const grow = sheet.animate([{ transform: from }, { transform: "none" }], { duration: GROW_MS, easing: EASE, fill: "forwards" });
  // La couverture s'efface dans la page pendant la seconde moitié : c'est elle qui devient la page.
  const fade = img?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }], { duration: GROW_MS, easing: "ease-in", fill: "forwards" });
  try {
    await Promise.all([grow.finished, fade?.finished]);
  } catch {
    /* annulée : on retire le calque */
  }
  return () => {
    const out = layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out", fill: "forwards" });
    void out.finished.finally(() => layer.remove()).catch(() => layer.remove());
  };
}
