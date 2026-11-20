"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { LoginBackground } from "@/lib/loginBackgroundShared";

/**
 * L'image de fond des écrans de connexion (DECISIONS §199). Le serveur la lit dans la mise en page
 * (`src/app/login/layout.tsx`, `src/app/partage/layout.tsx`) et la transmet par ce contexte : la page
 * la dessine dès le premier rendu, sans requête de plus ni écran noir qui s'éclaire ensuite. Sans
 * fournisseur — les tests, une installation sans image —, rien n'est dessiné : le noir d'avant.
 */
const LoginBackgroundContext = createContext<LoginBackground | null>(null);

export function LoginBackgroundProvider({ value, children }: { value: LoginBackground | null; children: ReactNode }) {
  return <LoginBackgroundContext.Provider value={value}>{children}</LoginBackgroundContext.Provider>;
}

/**
 * Le calque de l'image, premier enfant d'un `<main>` qui porte `isolate` : en `-z-10`, il passe sous tout
 * le contenu (la signature du bas n'est pas positionnée) mais au-dessus du fond noir du `<main>`. Le voile
 * garde la carte et le texte blancs lisibles sur une image claire ; un dégradé assombrit le bas, où vit
 * la signature. Une image qui ne charge pas disparaît : reste le noir.
 */
export function LoginBackdrop() {
  const bg = useContext(LoginBackgroundContext);
  const [failed, setFailed] = useState<string | null>(null);
  if (!bg || failed === bg.v) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10" data-login-backdrop>
      {/* eslint-disable-next-line @next/next/no-img-element -- une image publique servie sans session (`/api/login-background`), déjà réduite et en WebP : l'optimiseur de Next demande une session */}
      <img
        src={`/api/login-background?v=${bg.v}`}
        alt=""
        decoding="async"
        fetchPriority="high"
        onError={() => setFailed(bg.v)}
        className="h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-black" style={{ opacity: bg.dim / 100 }} />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/60 to-transparent" />
    </div>
  );
}
