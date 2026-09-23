export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    /**
     * Un secret de session par défaut n'est pas un avertissement, c'est une porte ouverte.
     *
     * Il était signalé par un message d'erreur dans les journaux, puis l'application démarrait
     * quand même : n'importe qui connaissant la valeur publiée peut alors forger une session
     * administrateur. Un démarrage qui échoue se voit ; une ligne dans les journaux, non.
     *
     * Ici et pas dans la configuration elle-même : `register` s'exécute au démarrage du serveur,
     * jamais pendant la compilation, où le secret n'a aucune raison d'être présent.
     */
    const { config } = await import("./lib/config");
    const { sessionSecretProblem, adminPasswordProblem } = await import("./lib/sessionSecret");
    const secretProblem = sessionSecretProblem(config.app.sessionSecret);
    if (secretProblem) {
      throw new Error(
        `${secretProblem} Posez-en un dans .env (openssl rand -hex 32) — sans lui, une session administrateur peut être forgée.`
      );
    }
    const passwordProblem = adminPasswordProblem(config.app.adminPassword);
    if (passwordProblem) {
      throw new Error(`${passwordProblem} Choisissez-en un dans .env, ou laissez-le vide pour désactiver le compte local.`);
    }

    const { startNotificationCron } = await import("./lib/notificationJobs");
    startNotificationCron();

    const { startTorrentWatch } = await import("./lib/torrentWatch");
    startTorrentWatch();

    const { startStatusCron } = await import("./lib/statusCron");
    startStatusCron();

    const { startDbBackupCron } = await import("./lib/dbBackup");
    startDbBackupCron();

    // Non-blocking cache warmup — fire and forget, never delays startup
    setTimeout(() => {
      import("./lib/server-cache").then(async ({ cachedMovies, cachedSeries }) => {
        // Les titres traduits aussi (voir `titleNames`) : demander chaque titre lance sa
        // recherche en arrière-plan, et la première ouverture après un déploiement les trouve
        // prêts au lieu de montrer les titres de Radarr une fois.
        const { getTitleNames } = await import("./lib/titleNames");
        cachedMovies().then((movies) => movies.forEach((m) => getTitleNames(m.tmdbId, "movie"))).catch(() => {});
        cachedSeries().then((series) => series.forEach((s) => getTitleNames(s.tmdbId, "series"))).catch(() => {});
      }).catch(() => {});
    }, 0);
  }
}
