"use client";

/**
 * Se déconnecter : prévenir le serveur, puis aller à la page de connexion — **quoi qu'il arrive**.
 *
 * Trois boutons l'écrivaient chacun (`await fetch(...)` puis `router.replace("/login")`), et aucun
 * ne gardait l'appel : hors ligne, `fetch` levait, la redirection ne partait jamais, et l'échec
 * finissait en rejet non géré dans server.log. On appuyait sur « Se déconnecter » et rien ne se
 * passait. L'appel au serveur est une politesse — il révoque la session de son côté — ; partir
 * vers la connexion, c'est ce que la personne a demandé.
 */
export async function signOut(go: (path: string) => void): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Hors ligne ou serveur absent : la page de connexion reste la destination demandée.
  }
  go("/login");
}
