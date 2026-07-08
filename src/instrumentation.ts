export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNotificationCron } = await import("./lib/notificationJobs");
    startNotificationCron();
  }
}
