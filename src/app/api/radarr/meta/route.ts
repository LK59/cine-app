import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(async () => {
    const [qualityProfiles, rootFolders] = await Promise.all([
      radarr.getQualityProfiles(),
      radarr.getRootFolders(),
    ]);
    return { qualityProfiles, rootFolders };
  });
}
