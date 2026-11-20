import type { ReactNode } from "react";
import { loginBackground } from "@/lib/loginBackground";
import { LoginBackgroundProvider } from "@/components/login/LoginBackdrop";

// La même image que la page de connexion (DECISIONS §199), sous le formulaire du code ; la fiche d'un lien ouvert ne la montre pas.
export const dynamic = "force-dynamic";

export default function ShareLayout({ children }: { children: ReactNode }) {
  return <LoginBackgroundProvider value={loginBackground()}>{children}</LoginBackgroundProvider>;
}
