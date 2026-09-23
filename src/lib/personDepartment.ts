type TFn = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Le métier d'une personne, tel que TMDB le range, dit dans la langue de l'app.
 *
 * TMDB renvoie son département en anglais quelle que soit la langue demandée — « Acting »
 * s'affichait tel quel sous le nom de chaque actrice (23/09/2026). Les noms sont ceux d'un métier
 * et non d'une personne (« Interprétation », pas « Acteur ») : TMDB ne dit pas le genre, et le
 * deviner d'après un prénom serait une erreur de plus.
 */
const DEPARTMENTS: Record<string, string> = {
  Acting: "acting",
  Directing: "directing",
  Writing: "writing",
  Production: "production",
  Sound: "sound",
  Camera: "camera",
  Editing: "editing",
  Art: "art",
  "Costume & Make-Up": "costume",
  Crew: "crew",
  "Visual Effects": "visualEffects",
  Lighting: "lighting",
  Creator: "creator",
};

/** `null` pour un département inconnu : mieux vaut rien qu'un mot anglais au milieu de l'écran. */
export function departmentLabel(t: TFn, department: string | null | undefined): string | null {
  const key = department ? DEPARTMENTS[department] : undefined;
  return key ? t(`person.department.${key}`) : null;
}
