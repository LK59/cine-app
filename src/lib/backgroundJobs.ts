/**
 * L'interrupteur des tâches de fond (DECISIONS.md §145, 11/11/2026).
 *
 * `CINE_BACKGROUND_JOBS=off` : le serveur sert ses pages et ses routes, et **rien d'autre ne part de
 * lui-même** — ni notification, ni ménage dans Jellyfin, ni masquage, ni planificateur, ni appel payant.
 * Seuls restent les préchauffages en lecture du catalogue, sans lesquels l'instance n'ouvrirait pas
 * comme la production.
 *
 * Il existe pour les copies de l'application lancées à côté de la vraie — le banc du lecteur
 * (`tools/regress-lecteur/`), une instance d'essai : elles démarrent avec les adresses et les clés de la
 * production, donc leurs tâches de fond agissaient sur les **vrais** services, avec une base recopiée
 * qui n'a pas tout. Le 10/11/2026, une instance du banc restée sept heures a retiré toutes les cinq
 * minutes le masquage de 92 titres dans Jellyfin ; la production le remettait à chaque passage.
 *
 * Neutraliser chaque tâche une à une dans l'outil (ce que `regress.sh` faisait) laisse toujours la
 * dernière-née passer. Ici c'est l'inverse : `instrumentation.ts` ne lance une tâche que derrière cet
 * interrupteur, et `background-jobs.test.ts` échoue si une tâche y est ajoutée sans lui.
 *
 * Par défaut — variable absente ou toute autre valeur — les tâches tournent : la production ne règle rien.
 */
export function backgroundJobsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.CINE_BACKGROUND_JOBS ?? "").trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0" || value === "no");
}
