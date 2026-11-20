import type { ReactNode } from "react";
import { loginBackground } from "@/lib/loginBackground";
import { LoginBackgroundProvider } from "@/components/login/LoginBackdrop";

// L'image de fond se lit à chaque affichage (DECISIONS §199) : l'administrateur la change sans redéployer.
export const dynamic = "force-dynamic";

export default function LoginLayout({ children }: { children: ReactNode }) {
  return <LoginBackgroundProvider value={loginBackground()}>{children}</LoginBackgroundProvider>;
}
