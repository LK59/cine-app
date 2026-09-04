import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { PlayerShell } from "@/components/player/PlayerShell";

/**
 * Le lecteur a sa propre coquille, et c'est tout l'intérêt du groupe de routes : pas de barre
 * latérale de gestion, pas de PageTransition (dont le `transform` permanent cassait le
 * `position: fixed` des écrans cinéma), pas de MainScroll. Une page noire, une navigation, et le
 * contenu.
 */
export default async function PlayerLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session) redirect("/login");

  return (
    <div className="app-viewport overflow-hidden bg-ink">
      {children}
      <PlayerShell />
    </div>
  );
}
