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
     *
     * En production, `server-boot/boot.mjs` a déjà refusé avant d'importer le serveur, et sort :
     * une exception levée ici, Next la rattrape en « Failed to prepare server » sans quitter, et le
     * conteneur restait « Up » à répondre 500 (audit du 29/09/2026). Ce second contrôle, mêmes
     * règles et même message, reste pour `next dev` — qui ne passe pas par `boot.mjs` — et pour
     * toute autre façon de lancer `server.js` directement.
     */
    const { config } = await import("./lib/config");
    const { startupRefusal } = await import("./lib/sessionSecret");
    const refusal = startupRefusal({ sessionSecret: config.app.sessionSecret, adminPassword: config.app.adminPassword });
    if (refusal) throw new Error(refusal);

    const { startNotificationCron } = await import("./lib/notificationJobs");
    startNotificationCron();

    const { startTorrentWatch } = await import("./lib/torrentWatch");
    startTorrentWatch();

    const { startStatusCron } = await import("./lib/statusCron");
    startStatusCron();

    const { startDbBackupCron } = await import("./lib/dbBackup");
    startDbBackupCron();

    // Les appareils « CineApp » que plus aucune session ne réclame, retirés de Jellyfin après trente
    // jours d'inactivité : chaque connexion en inscrit un, et une session jamais déconnectée laissait
    // le sien pour toujours (32 au 29/09/2026). Une fois par jour — voir `jellyfinDevicePrune.ts`.
    const { startJellyfinDevicePruneCron } = await import("./lib/jellyfinDevicePrune");
    startJellyfinDevicePruneCron();

    // Les affiches du catalogue préparées d'avance dans les tailles que les écrans demandent : sans
    // cela, la première personne à voir un titre payait 60 à 350 ms par affiche (25/09/2026). En
    // arrière-plan, une minute après le démarrage — voir `posterPrewarm.ts`.
    const { startPosterPrewarm } = await import("./lib/posterPrewarm");
    startPosterPrewarm();

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
