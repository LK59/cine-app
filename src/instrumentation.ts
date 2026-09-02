export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
