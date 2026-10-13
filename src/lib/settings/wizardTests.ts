import { SETTINGS, TESTABLE_GROUPS, type SettingGroup, type SettingView, type TestableGroup } from "./schema";

/**
 * Les services de l'étape à tester à « Suivant » : Jellyfin et TMDB toujours (obligatoires), les
 * autres seulement s'ils sont renseignés — un secret posé, ou une adresse qui n'est plus celle par
 * défaut. Un complément laissé vide n'est pas un échec : il n'est pas branché.
 */
export function groupsToTest(groups: SettingGroup[], settings: SettingView[]): TestableGroup[] {
  const views = new Map(settings.map((v) => [v.key, v]));
  return (TESTABLE_GROUPS as readonly TestableGroup[]).filter((g) => {
    if (!groups.includes(g)) return false;
    if (SETTINGS.some((d) => d.group === g && d.need === "required")) return true;
    return SETTINGS.some((d) => {
      if (d.group !== g) return false;
      const v = views.get(d.key);
      if (!v) return false;
      if (d.kind === "secret") return v.set;
      return d.kind === "url" && v.source !== "default" && !!v.value;
    });
  });
}
