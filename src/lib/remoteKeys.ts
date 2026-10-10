/**
 * Les touches d'une télécommande, ramenées aux noms que tout le cinéma attend (10/10/2026).
 *
 * Timothé ne pouvait pas « descendre » avec la télécommande de sa Fire TV Stick (Silk 152). Les
 * gestionnaires du cinéma — la grille (`useTvGridNav`), la bannière, les fiches, le lecteur — lisent
 * tous `e.key === "ArrowDown"`, `"Enter"`, `"Escape"`. Un navigateur de téléviseur ne garantit pas ces
 * noms : les vieux moteurs envoient « Down », « Esc », d'autres un `key` vide ou « Unidentified » avec
 * le seul `keyCode` (Amazon documente pour sa télécommande 37–40, 13 au centre, 179 lecture/pause,
 * 227/228 retour/avance rapides). Plutôt que d'apprendre ces variantes à chacun des gestionnaires —
 * une vingtaine, et le prochain l'oublierait —, une seule écoute, en capture, avant tout le monde,
 * réémet l'évènement sous son nom moderne et retient l'original. Un évènement déjà bien nommé
 * (le cas de tout clavier, et sans doute de Silk lui-même) n'est pas touché.
 *
 * La touche Retour d'une Fire TV (keyCode 4) n'est pas traduite : Silk la traite déjà en retour
 * d'historique, et le cinéma ferme ses fiches sur ce retour (`cinemaRoute`). La traduire aussi en
 * Échap fermerait deux choses pour un appui.
 */

const LEGACY_NAMES: Record<string, string> = {
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Esc: "Escape",
  // DPAD_CENTER, sur les télécommandes qui le nomment.
  Select: "Enter",
  Accept: "Enter",
  // Les touches médias, telles que les nomment certains moteurs Android.
  MediaPlay: "MediaPlayPause",
};

const BY_KEY_CODE: Record<number, string> = {
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  13: "Enter",
  // KEYCODE_DPAD_CENTER d'Android, quand il passe tel quel.
  23: "Enter",
  27: "Escape",
  179: "MediaPlayPause",
  // KEYCODE_MEDIA_PLAY_PAUSE d'Android.
  85: "MediaPlayPause",
  227: "MediaRewind",
  228: "MediaFastForward",
};

/** Le nom moderne de la touche, ou `null` quand l'évènement ne dit rien qu'on sache lire. */
export function normalizeKey(e: { key?: string | null; keyCode?: number; which?: number }): string | null {
  const key = e.key ?? "";
  if (key && key !== "Unidentified") return LEGACY_NAMES[key] ?? key;
  const code = e.keyCode || e.which || 0;
  return BY_KEY_CODE[code] ?? null;
}

/** Faut-il réémettre cet évènement sous un autre nom ? */
export function needsTranslation(e: { key?: string | null; keyCode?: number; which?: number }): string | null {
  const normalized = normalizeKey(e);
  if (!normalized || normalized === (e.key ?? "")) return null;
  return normalized;
}

/**
 * Pose l'écoute qui traduit. Renvoie de quoi la retirer.
 *
 * L'évènement d'origine est arrêté (plus personne ne le voit) et un évènement de même cible, bien
 * nommé, part à sa place : les gestionnaires React comme ceux posés sur `window` le reçoivent. Un
 * évènement fabriqué n'a pas d'action par défaut — un Entrée réémis n'active donc rien de lui-même :
 * s'il n'a pas été pris en charge, l'élément focalisé est cliqué, ce que l'Entrée d'origine aurait fait.
 */
const translatedEvents = new WeakSet<Event>();

/** Un évènement réémis par la traduction — que le relevé de Fire TV ne doit pas compter deux fois. */
export function isTranslatedKey(e: Event): boolean {
  return translatedEvents.has(e);
}

export function installRemoteKeyShim(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // Les siens, réémis plus bas, repassent par ici : ils sont déjà bien nommés, mais on ne les
    // regarde même pas.
    if (translatedEvents.has(e)) return;
    const key = needsTranslation(e);
    if (!key) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const at = (e.target as EventTarget | null) ?? target.document.body;
    const translated = new KeyboardEvent("keydown", {
      key,
      code: e.code,
      bubbles: true,
      cancelable: true,
      composed: true,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      repeat: e.repeat,
    });
    translatedEvents.add(translated);
    const handled = !at.dispatchEvent(translated);
    if (key === "Enter" && !handled) {
      const el = target.document.activeElement as HTMLElement | null;
      if (el && el !== target.document.body && typeof el.click === "function") el.click();
    }
  };
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}
