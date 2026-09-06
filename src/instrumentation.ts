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
    if (config.app.sessionSecret === "change-me-in-production") {
      throw new Error(
        "SESSION_SECRET n'est pas défini. Posez-en un dans .env — sans lui, une session administrateur peut être forgée."
      );
    }

    const { startNotificationCron } = await import("./lib/notificationJobs");
    startNotificationCron();

    const { startStatusCron } = await import("./lib/statusCron");
    startStatusCron();

    const { startDbBackupCron } = await import("./lib/dbBackup");
    startDbBackupCron();

    // Non-blocking cache warmup — fire and forget, never delays startup
    setTimeout(() => {
      import("./lib/server-cache").then(({ cachedMovies, cachedSeries }) => {
        cachedMovies().catch(() => {});
        cachedSeries().catch(() => {});
      }).catch(() => {});
    }, 0);
  }
}
