import { NextRequest, NextResponse } from "next/server";
import { jackett } from "@/lib/clients/jackett";

// Un identifiant d'indexeur Jackett (`yggreborn-api`, `torrent9`…). Le segment était collé tel
// quel dans le chemin de l'appel à Jackett, clé d'API en paramètre : `..%2F` ou `?` y
// choisissaient un autre point d'entrée que le test (26/09/2026).
const INDEXER_ID = /^[A-Za-z0-9_-]{1,100}$/;

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (!INDEXER_ID.test(params.id)) {
    return NextResponse.json({ error: "Indexeur invalide" }, { status: 400 });
  }
  const ok = await jackett.testIndexer(params.id);
  return NextResponse.json({ ok });
}
