import type { CalendarEvent } from "@/app/api/calendar/route";

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Ce que l'écran du calendrier écrit sous le titre d'un événement. La route renvoie le genre de
 * sortie d'un film (`release`) et non son libellé : elle écrivait « Au cinéma », « Sortie
 * digitale »… en français, et l'écran les montrait tels quels en anglais, espagnol et allemand.
 * La ligne d'un épisode (« S01E02 · Titre ») n'a rien à traduire et passe telle quelle.
 */
export function calendarEventDetail(ev: CalendarEvent, t: T): string | null {
  if (ev.release) return t(`calendar.release.${ev.release}`);
  return ev.detail;
}

/** Le titre, ou « Série » dans la langue du compte quand Sonarr n'a pas donné celui de la série. */
export function calendarEventTitle(ev: CalendarEvent, t: T): string {
  if (ev.title) return ev.title;
  return ev.type === "series" ? t("calendar.sources.librarySeries") : "";
}
