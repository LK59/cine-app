import { sonarr } from "@/lib/clients/sonarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(async () => {
    const [qualityProfiles, rootFolders] = await Promise.all([
      sonarr.getQualityProfiles(),
      sonarr.getRootFolders(),
    ]);
    return { qualityProfiles, rootFolders };
  });
}
