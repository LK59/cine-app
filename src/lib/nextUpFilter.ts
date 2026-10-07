// Ce que « À suivre » ne propose pas — voir `untouchedPilot`.

/**
 * Une série proposée sur son tout premier épisode, jamais commencé : rien n'est « à suivre ».
 * Jellyfin en ajoute une à chaque série qui arrive dans la bibliothèque, et elles s'accumulaient
 * dans la rangée et dans la bannière, devant ce qu'on regardait vraiment (07/10/2026). Un premier
 * épisode entamé, lui, est une vraie reprise et reste.
 */
export function untouchedPilot(item: { ParentIndexNumber?: number | null; IndexNumber?: number | null; UserData?: { PlaybackPositionTicks?: number | null } | null }): boolean {
  return item.ParentIndexNumber === 1 && item.IndexNumber === 1 && !(item.UserData?.PlaybackPositionTicks && item.UserData.PlaybackPositionTicks > 0);
}
