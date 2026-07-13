export const NOTIFICATION_CATEGORIES = [
  {
    id: "torrent-complete",
    label: "Torrent terminé",
    labelKey: "notifications.categoriesList.torrentComplete.label",
    description: "Quand un téléchargement passe en terminé.",
    descKey: "notifications.categoriesList.torrentComplete.description",
    enabledByDefault: true,
  },
  {
    id: "torrent-started",
    label: "Torrent démarré",
    labelKey: "notifications.categoriesList.torrentStarted.label",
    description: "Quand un nouveau téléchargement démarre.",
    descKey: "notifications.categoriesList.torrentStarted.description",
    enabledByDefault: false,
  },
  {
    id: "watchlist-available",
    label: "Film/Série disponible",
    labelKey: "notifications.categoriesList.watchlistAvailable.label",
    description: "Quand un contenu de ta liste devient disponible dans Jellyfin.",
    descKey: "notifications.categoriesList.watchlistAvailable.description",
    enabledByDefault: true,
  },
  {
    id: "new-episode",
    label: "Nouvel épisode",
    labelKey: "notifications.categoriesList.newEpisode.label",
    description: "Quand un nouvel épisode est importé pour une série suivie.",
    descKey: "notifications.categoriesList.newEpisode.description",
    enabledByDefault: true,
  },
] as const;

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]["id"];

export function getDefaultNotificationPreferences(): Record<NotificationCategory, boolean> {
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category.id, category.enabledByDefault])
  ) as Record<NotificationCategory, boolean>;
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return NOTIFICATION_CATEGORIES.some((category) => category.id === value);
}
