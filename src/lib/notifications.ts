export const NOTIFICATION_CATEGORIES = [
  {
    id: "torrent-complete",
    label: "Torrent terminé",
    description: "Quand un téléchargement passe en terminé.",
    enabledByDefault: true,
  },
  {
    id: "torrent-started",
    label: "Torrent démarré",
    description: "Quand un nouveau téléchargement démarre.",
    enabledByDefault: false,
  },
  {
    id: "watchlist-available",
    label: "Film/Série disponible",
    description: "Quand un contenu de ta liste devient disponible dans Jellyfin.",
    enabledByDefault: true,
  },
  {
    id: "new-episode",
    label: "Nouvel épisode",
    description: "Quand un nouvel épisode est importé pour une série suivie.",
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
