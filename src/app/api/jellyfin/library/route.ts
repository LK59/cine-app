import { jellyfin } from "@/lib/clients/jellyfin";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(async () => {
    const [counts, systemInfo] = await Promise.all([
      jellyfin.getLibraryCounts(),
      jellyfin.getSystemInfo(),
    ]);
    return { counts, systemInfo };
  });
}
