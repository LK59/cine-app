import { NextResponse } from "next/server";
import { radarr } from "@/lib/clients/radarr";
import { defaultQualityProfile } from "@/lib/qualityProfile";

export async function GET() {
  try {
    const [qualityProfiles, rootFolders] = await Promise.all([
      radarr.getQualityProfiles(),
      radarr.getRootFolders(),
    ]);
    // Le profil des ajouts (`defaultQualityProfile`) voyage avec la liste : les formulaires de la
    // gestion le présélectionnent. Plus de cache partagé de cinq minutes — un profil changé dans
    // « Connexions » doit valoir au prochain ajout.
    const defaultQualityProfileId = defaultQualityProfile("radarr", qualityProfiles)?.id ?? null;
    return NextResponse.json({ qualityProfiles, rootFolders, defaultQualityProfileId }, {
      headers: { "Cache-Control": "private, max-age=30" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
