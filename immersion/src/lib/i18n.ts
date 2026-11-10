/**
 * Les textes du mode, dans les quatre langues de l'application.
 *
 * La langue est celle du compte (`/api/user/preferences`), comme partout dans Laterna ; en attendant
 * la réponse, celle du navigateur. L'allemand vouvoie, comme le reste de l'application.
 */
export type Lang = "fr" | "en" | "es" | "de";

const fr = {
  "brand.mode": "Immersion",
  "unsupported.title": "Expérience disponible sur ordinateur",
  "unsupported.pointer": "Le mode Immersion se visite à la souris et au clavier.",
  "unsupported.screen": "La fenêtre est trop petite pour le mode Immersion. Agrandissez-la, puis réessayez.",
  "unsupported.webgl": "Ce navigateur n'offre pas le rendu 3D nécessaire (WebGL 2).",
  "back": "Retour à Laterna",
  "retry": "Réessayer",
  "loading.title": "Le chalet se prépare",
  "loading.detail": "Chargement des textures et des modèles",
  "gate.title": "Le chalet",
  "gate.subtitle": "Une nuit de neige, un feu de bougies, et tout votre cinéma.",
  "gate.enter": "Cliquer pour entrer",
  "gate.move": "Se déplacer",
  "gate.look": "Regarder",
  "gate.run": "Courir",
  "gate.tv": "Ouvrir Laterna près de la télévision",
  "gate.sit": "S'asseoir",
  "gate.pause": "Menu",
  "key.mouse": "Souris",
  "key.shift": "Maj",
  "key.esc": "Échap",
  "key.space": "Espace",
  "pause.title": "Pause",
  "pause.resume": "Reprendre",
  "pause.settings": "Réglages",
  "pause.quit": "Quitter l'immersion",
  "hint.tv": "Ouvrir Laterna",
  "hint.sit": "S'asseoir",
  "hint.stand": "Se lever",
  "hint.click": "Cliquer pour reprendre la visite",
  "error.context": "Le rendu 3D s'est interrompu.",
  "error.context.detail": "Le navigateur a repris la carte graphique. Rechargez pour revenir au chalet.",
  "error.reload": "Recharger",
  "error.crash": "Le chalet n'a pas pu s'afficher.",
  "error.session": "Votre session a pris fin.",
  "error.session.detail": "Reconnectez-vous pour revenir au chalet.",
  "error.login": "Se connecter",
};

export type Key = keyof typeof fr;

const en: Record<Key, string> = {
  "brand.mode": "Immersion",
  "unsupported.title": "Experience available on a computer",
  "unsupported.pointer": "Immersion mode is explored with a mouse and keyboard.",
  "unsupported.screen": "The window is too small for Immersion mode. Enlarge it, then try again.",
  "unsupported.webgl": "This browser lacks the 3D rendering it needs (WebGL 2).",
  "back": "Back to Laterna",
  "retry": "Try again",
  "loading.title": "The chalet is getting ready",
  "loading.detail": "Loading textures and models",
  "gate.title": "The chalet",
  "gate.subtitle": "A snowy night, candlelight, and all your films.",
  "gate.enter": "Click to enter",
  "gate.move": "Move",
  "gate.look": "Look",
  "gate.run": "Run",
  "gate.tv": "Open Laterna near the television",
  "gate.sit": "Sit down",
  "gate.pause": "Menu",
  "key.mouse": "Mouse",
  "key.shift": "Shift",
  "key.esc": "Esc",
  "key.space": "Space",
  "pause.title": "Paused",
  "pause.resume": "Resume",
  "pause.settings": "Settings",
  "pause.quit": "Leave Immersion",
  "hint.tv": "Open Laterna",
  "hint.sit": "Sit down",
  "hint.stand": "Stand up",
  "hint.click": "Click to resume the visit",
  "error.context": "3D rendering stopped.",
  "error.context.detail": "The browser took the graphics card back. Reload to return to the chalet.",
  "error.reload": "Reload",
  "error.crash": "The chalet could not be displayed.",
  "error.session": "Your session has ended.",
  "error.session.detail": "Sign in again to return to the chalet.",
  "error.login": "Sign in",
};

const es: Record<Key, string> = {
  "brand.mode": "Inmersión",
  "unsupported.title": "Experiencia disponible en ordenador",
  "unsupported.pointer": "El modo Inmersión se recorre con ratón y teclado.",
  "unsupported.screen": "La ventana es demasiado pequeña para el modo Inmersión. Amplíela y vuelva a intentarlo.",
  "unsupported.webgl": "Este navegador no ofrece el renderizado 3D necesario (WebGL 2).",
  "back": "Volver a Laterna",
  "retry": "Reintentar",
  "loading.title": "El chalet se está preparando",
  "loading.detail": "Cargando texturas y modelos",
  "gate.title": "El chalet",
  "gate.subtitle": "Una noche de nieve, luz de velas y todo su cine.",
  "gate.enter": "Haga clic para entrar",
  "gate.move": "Moverse",
  "gate.look": "Mirar",
  "gate.run": "Correr",
  "gate.tv": "Abrir Laterna junto al televisor",
  "gate.sit": "Sentarse",
  "gate.pause": "Menú",
  "key.mouse": "Ratón",
  "key.shift": "Mayús",
  "key.esc": "Esc",
  "key.space": "Espacio",
  "pause.title": "Pausa",
  "pause.resume": "Reanudar",
  "pause.settings": "Ajustes",
  "pause.quit": "Salir de la inmersión",
  "hint.tv": "Abrir Laterna",
  "hint.sit": "Sentarse",
  "hint.stand": "Levantarse",
  "hint.click": "Haga clic para reanudar la visita",
  "error.context": "El renderizado 3D se ha interrumpido.",
  "error.context.detail": "El navegador ha recuperado la tarjeta gráfica. Recargue para volver al chalet.",
  "error.reload": "Recargar",
  "error.crash": "No se ha podido mostrar el chalet.",
  "error.session": "Su sesión ha terminado.",
  "error.session.detail": "Vuelva a iniciar sesión para regresar al chalet.",
  "error.login": "Iniciar sesión",
};

const de: Record<Key, string> = {
  "brand.mode": "Immersion",
  "unsupported.title": "Erlebnis am Computer verfügbar",
  "unsupported.pointer": "Der Immersionsmodus wird mit Maus und Tastatur erkundet.",
  "unsupported.screen": "Das Fenster ist für den Immersionsmodus zu klein. Vergrößern Sie es und versuchen Sie es erneut.",
  "unsupported.webgl": "Dieser Browser bietet nicht die nötige 3D-Darstellung (WebGL 2).",
  "back": "Zurück zu Laterna",
  "retry": "Erneut versuchen",
  "loading.title": "Das Chalet wird vorbereitet",
  "loading.detail": "Texturen und Modelle werden geladen",
  "gate.title": "Das Chalet",
  "gate.subtitle": "Eine Schneenacht, Kerzenlicht und Ihr ganzes Kino.",
  "gate.enter": "Zum Eintreten klicken",
  "gate.move": "Bewegen",
  "gate.look": "Umsehen",
  "gate.run": "Rennen",
  "gate.tv": "Laterna beim Fernseher öffnen",
  "gate.sit": "Hinsetzen",
  "gate.pause": "Menü",
  "key.mouse": "Maus",
  "key.shift": "Umschalt",
  "key.esc": "Esc",
  "key.space": "Leertaste",
  "pause.title": "Pause",
  "pause.resume": "Fortsetzen",
  "pause.settings": "Einstellungen",
  "pause.quit": "Immersion verlassen",
  "hint.tv": "Laterna öffnen",
  "hint.sit": "Hinsetzen",
  "hint.stand": "Aufstehen",
  "hint.click": "Klicken, um den Rundgang fortzusetzen",
  "error.context": "Die 3D-Darstellung wurde unterbrochen.",
  "error.context.detail": "Der Browser hat die Grafikkarte zurückgenommen. Laden Sie neu, um ins Chalet zurückzukehren.",
  "error.reload": "Neu laden",
  "error.crash": "Das Chalet konnte nicht angezeigt werden.",
  "error.session": "Ihre Sitzung ist beendet.",
  "error.session.detail": "Melden Sie sich erneut an, um ins Chalet zurückzukehren.",
  "error.login": "Anmelden",
};

export const DICTIONARIES: Record<Lang, Record<Key, string>> = { fr, en, es, de };

export function isLang(value: unknown): value is Lang {
  return value === "fr" || value === "en" || value === "es" || value === "de";
}

/** La langue du navigateur, en attendant celle du compte. */
export function browserLang(): Lang {
  const two = (navigator.language || "fr").slice(0, 2).toLowerCase();
  return isLang(two) ? two : "en";
}

export function translate(lang: Lang, key: Key): string {
  return DICTIONARIES[lang][key] ?? fr[key] ?? key;
}
