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
