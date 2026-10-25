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
    // Les secrets du premier lancement, comme `boot.mjs` les pose en production : sans eux, `next
    // dev` sur une installation neuve (sans `.env`) refuserait de démarrer (DECISIONS.md §48).
    // Idempotent : ce que l'environnement donne déjà n'est jamais touché.
    try {
      const { applyFirstRunSecrets } = await import("../server-boot/firstRunSecrets.mjs");
      const { DATA_DIR } = await import("./lib/dataDir");
      await applyFirstRunSecrets(DATA_DIR);
    } catch {
      /* le contrôle ci-dessous dira ce qui manque */
    }
    const { config } = await import("./lib/config");
    const { startupRefusal } = await import("./lib/sessionSecret");
    const refusal = startupRefusal({ sessionSecret: config.app.sessionSecret, adminPassword: config.app.adminPassword });
    if (refusal) throw new Error(refusal);

    // Le code d'installation (20/10/2026) : tant qu'aucun compte administrateur n'existe, tiré une
    // fois et écrit dans les journaux du conteneur à chaque démarrage — l'assistant le demande pour
    // créer ce compte, que le premier visiteur venu ne puisse pas le faire. Une installation qui a
    // déjà un administrateur n'écrit rien. Gardé : un échec ici ne coûte que le code, que la route
    // tire à son tour (ou refuse) — jamais le démarrage.
    try {
      const { announceSetupCode } = await import("./lib/settings/setupCode");
      announceSetupCode();
    } catch (error) {
      console.error(`[setup] setup code unavailable: ${error instanceof Error ? error.message : error}`);
    }

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

    // Les tags bloqués d'office (« prive ») posés sur chaque compte Jellyfin créé ensuite, dans les
    // cinq minutes — voir `newAccountTags.ts`.
    const { startNewAccountTagsCron } = await import("./lib/newAccountTags");
    startNewAccountTagsCron();

    // Les liens de partage finis : leur compte Jellyfin désactivé, puis effacé un mois plus tard —
    // voir `share/service.ts` (DECISIONS.md §112).
    const { startShareSweep } = await import("./lib/share/service");
    startShareSweep();

    // Les affiches du catalogue préparées d'avance dans les tailles que les écrans demandent : sans
    // cela, la première personne à voir un titre payait 60 à 350 ms par affiche (25/09/2026). En
    // arrière-plan, une minute après le démarrage — voir `posterPrewarm.ts`.
    const { startPosterPrewarm } = await import("./lib/posterPrewarm");
    startPosterPrewarm();

    // Les listes de la bibliothèque (Radarr, Sonarr, Jellyfin) lues au démarrage et relues avant
    // d'expirer : aucune ouverture ne les attend plus — voir `withKeptCache`.
    const { startCatalogueWarm } = await import("./lib/catalogueWarm");
    startCatalogueWarm();

    // Les sous-titres générés (DECISIONS.md §69) : les tâches en cours reprennent là où elles
    // étaient — lignes acquises gardées — et les fichiers finis continuent vers Jellyfin. Gardé :
    // une base illisible ne doit pas empêcher le serveur de démarrer.
    try {
      const { startEngine } = await import("./lib/subtitleGen/engine");
      startEngine();
    } catch (error) {
      console.error("subtitle-gen: démarrage", error);
    }

    // La recherche de répliques (DECISIONS.md §88) : une passe interrompue par le redémarrage reprend
    // au film suivant, et la mise à jour de nuit est surveillée. Rien ne tourne tant que l'option est
    // coupée. Gardé, comme les sous-titres générés.
    try {
      const { startRepliquesEngine } = await import("./lib/repliques/engine");
      startRepliquesEngine();
    } catch (error) {
      console.error("repliques: démarrage", error);
    }

    // L'intégrité des fichiers (DECISIONS.md §93) : une passe manuelle interrompue par le redémarrage
    // reprend, et la vérification de nuit des fichiers nouveaux est surveillée — seulement après une
    // première passe lancée par l'administrateur. Gardé, comme les répliques.
    try {
      const { startIntegrityEngine } = await import("./lib/integrity/engine");
      startIntegrityEngine();
    } catch (error) {
      console.error("integrite: démarrage", error);
    }

    // Le téléchargement hors ligne (bêta) : les préparations coupées par le redémarrage repartent,
    // et les versions que plus personne ne télécharge sont effacées (`offline/jobs.ts`).
    try {
      const { startOfflineJobs } = await import("./lib/offline/jobs");
      startOfflineJobs();
    } catch (error) {
      console.error("hors ligne: démarrage", error);
    }

    // Ce qui tourne en arrière-plan, et à quel rythme — la première ligne à lire dans `docker logs`
    // (25/10/2026). Chaque tâche écrit ensuite une ligne par action (`taskLog`), jamais par tour.
    const { taskLog } = await import("./lib/taskLog");
    taskLog(
      "tâches",
      "planifiées : services 1 min · torrents 15 s · demandes disponibles 5 min · « à voir » et nouveaux épisodes 1 h · " +
        "nouveaux comptes 5 min · liens de partage 1 min · sauvegarde 1×/jour · appareils Jellyfin 1×/jour · " +
        "listes de la bibliothèque relues avant d'expirer · hors ligne, sous-titres générés, répliques et intégrité selon leur file"
    );

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
