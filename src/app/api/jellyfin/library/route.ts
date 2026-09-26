import { jellyfin } from "@/lib/clients/jellyfin";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(async () => {
    const [counts, systemInfo] = await Promise.all([
      jellyfin.getLibraryCounts(),
      jellyfin.getSystemInfo(),
    ]);
    // Le nom et la version, seuls lus par la page Jellyfin (son sous-titre). `/System/Info` entier
    // partait à tout compte connecté : chemins du serveur (journaux, cache, transcodage, données),
    // adresse locale, système d'exploitation, identifiant de l'instance (26/09/2026).
    return { counts, systemInfo: { ServerName: systemInfo.ServerName, Version: systemInfo.Version } };
  });
}
