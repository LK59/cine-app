import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
/**
 * Deux polices, servies depuis le dépôt — voir `fonts/fonts.css`, qui pose `--font-sans` et
 * `--font-display`.
 *
 * Inter partout est le choix le plus reconnaissable qui soit : c'est la police par défaut de la
 * moitié des applications sombres, et une interface se reconnaît d'abord à sa typographie. Les
 * titres sont ce qu'on lit le plus et ce qui porte le ton ; les changer change tout, pour un
 * fichier de police et rien d'autre.
 *
 * Bricolage Grotesque est un grotesque de titrage : des proportions un peu resserrées, de vraies
 * particularités de dessin aux grandes tailles, et assez neutre pour tenir à côté d'une affiche
 * sans lui faire concurrence. Inter reste pour tout le texte d'interface, où sa neutralité est
 * exactement ce qu'on veut.
 */
import "./fonts/fonts.css";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SWRProvider } from "@/components/SWRProvider";
import { ToastProvider } from "@/components/Toast";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TranslationProvider } from "@/components/TranslationProvider";
import { PlaybackProvider } from "@/components/PlaybackProvider";
import { LOCALES, LOCALE_COOKIE, loadLocaleDict, type Locale } from "@/lib/i18n";
import { InstallPrompt } from "@/components/InstallPrompt";
import { PlayerHostLazy } from "@/components/PlayerHostLazy";
import { BenchGate } from "@/components/player/BenchRunner";
import { MaintenanceNotices } from "@/components/MaintenanceNotices";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ClientErrorListener } from "@/components/ClientErrorListener";
import { PresencePinger } from "@/components/PresencePinger";

// Portrait iOS splash screens, keyed by CSS width/height/DPR so Safari picks
// the right one for the device at launch (avoids the blank flash).
/**
 * Les écrans de lancement d'iOS — et ce qu'il se passe quand aucun ne correspond.
 *
 * Une application posée sur l'écran d'accueil affiche une image pendant que WebKit démarre. iOS ne
 * la redimensionne pas : il cherche un `apple-touch-startup-image` dont la requête média désigne
 * **exactement** cet appareil, dans cette orientation. Faute de quoi il affiche du **blanc**, quel
 * que soit le `background_color` du manifeste.
 *
 * C'est ce que Louis voyait le 20/09/2026 : la liste ne couvrait que dix iPhone, tous en portrait,
 * et aucun iPad. Les images sont du noir uni — vérifié en décodant l'une d'elles, pixel du centre
 * compris — donc en ajouter ne coûte presque rien : une de 2048×2732 pèse 16 Ko.
 *
 * Les deux orientations sont émises depuis la même ligne : oublier le paysage sur un iPad, c'était
 * se retrouver blanc une fois sur deux. Un appareil absent de cette liste redevient blanc au
 * lancement — c'est la seule chose à savoir en la relisant.
 */
const SPLASH_SCREENS: { width: number; height: number; dpr: number }[] = [
  // iPhone
  { width: 440, height: 956, dpr: 3 },
  { width: 430, height: 932, dpr: 3 },
  { width: 428, height: 926, dpr: 3 },
  { width: 414, height: 896, dpr: 3 },
  { width: 414, height: 896, dpr: 2 },
  { width: 414, height: 736, dpr: 3 },
  { width: 402, height: 874, dpr: 3 },
  { width: 393, height: 852, dpr: 3 },
  { width: 390, height: 844, dpr: 3 },
  { width: 375, height: 812, dpr: 3 },
  { width: 375, height: 667, dpr: 2 },
  { width: 320, height: 568, dpr: 2 },
  // iPad
  { width: 1032, height: 1376, dpr: 2 },
  { width: 1024, height: 1366, dpr: 2 },
  { width: 834, height: 1210, dpr: 2 },
  { width: 834, height: 1194, dpr: 2 },
  { width: 820, height: 1180, dpr: 2 },
  { width: 834, height: 1112, dpr: 2 },
  { width: 810, height: 1080, dpr: 2 },
  { width: 768, height: 1024, dpr: 2 },
  { width: 744, height: 1133, dpr: 2 },
];

export const metadata: Metadata = {
  title: "Cine App",
  // Ce que voit quelqu'un à qui on partage le lien, et ce que l'écran de connexion dit déjà.
  description: "Vos films et vos séries.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Cine App",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0c",
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const rawLang = (await cookies()).get(LOCALE_COOKIE)?.value ?? "";
  const lang: Locale = LOCALES.includes(rawLang as Locale) ? rawLang as Locale : "fr";
  const dict = await loadLocaleDict(lang);
  return (
    <html lang={lang} className="dark">
      <head>
        {/*
          Le fond du document, déclaré en ligne — et ce qu'on n'a **pas** prouvé.

          Entre l'aboutissement de la navigation et le premier dessin, le navigateur montre sa
          propre page vide, blanche. L'idée était que ces quelques octets la rendent noire. Mesuré
          le 20/09/2026 : **non vérifié**. Une feuille de style bloque le rendu, donc rien ne se
          dessine avant son arrivée, style en ligne ou pas ; et le banc sans interface ne rapporte
          aucun temps de dessin, donc il n'a pas pu trancher.

          Gardé quand même : quarante octets, aucun risque, et le fond de la racine gagne à être
          déclaré sans dépendre d'un fichier. Mais ce n'est pas le correctif du blanc au
          lancement — celui-là, ce sont les images ci-dessous. Ne pas le créditer d'un gain qu'il
          n'a jamais montré.
        */}
        {/*
          La méta qu'Apple exige pour les écrans de lancement, et que Next n'écrit plus.

          Sa documentation est explicite : `apple-touch-startup-image` n'est lu que si
          l'application est déclarée plein écran par `apple-mobile-web-app-capable`. Next 16 ne
          produit plus que son successeur, `mobile-web-app-capable` — assez pour qu'iOS lance bien
          l'application sans barre d'adresse, visiblement pas pour qu'il aille chercher l'image de
          lancement.

          Écrite à la main, donc, à côté de celle de Next et sans la remplacer : les deux noms
          coexistent chez Apple, et celui-ci est le seul que la documentation des images cite.

          Relevé le 20/09/2026 après avoir éliminé tout le reste — les images existent, le proxy
          les sert (200, image/png, vérifié jusque depuis l'extérieur), l'appareil est dans la
          liste, le manifeste porte son fond sombre. C'était la dernière pièce manquante.
        */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <style dangerouslySetInnerHTML={{ __html: "html,body{background:#0a0a0c}" }} />
        {/* Apply saved theme before first paint to avoid flash */}
        <script dangerouslySetInnerHTML={{ __html: `try{var a=localStorage.getItem("cine-accent")||"violet";document.documentElement.dataset.accent=a;}catch(e){}` }} />
        {SPLASH_SCREENS.flatMap((s) =>
          (["portrait", "landscape"] as const).map((orientation) => {
            // iOS veut la taille du fichier en pixels de l'appareil, et dans le sens où il se
            // tient : en paysage, c'est la hauteur qui devient la largeur.
            const [w, h] = orientation === "portrait" ? [s.width, s.height] : [s.height, s.width];
            return (
              <link
                key={`${s.width}-${s.height}-${s.dpr}-${orientation}`}
                rel="apple-touch-startup-image"
                href={`/splash/apple-splash-${w * s.dpr}-${h * s.dpr}.png`}
                media={`(device-width: ${s.width}px) and (device-height: ${s.height}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: ${orientation})`}
              />
            );
          })
        )}
      </head>
      <body>
        <TranslationProvider initialLocale={lang} initialDict={dict}>
          <ThemeProvider>
            <SWRProvider>
              <ToastProvider>
                <PlaybackProvider>
                  {children}
                  {/* Monté à la racine, et non plus dans la coquille de gestion : le lecteur et
                      le tableau de bord sont maintenant deux groupes de routes distincts, et
                      passer de l'un à l'autre démontait l'élément <video>. PlayerHost ne rend
                      rien tant que rien ne joue, donc le coût est nul ailleurs. */}
                  {/* Chacun dans sa propre barrière, et ce n'est pas de la prudence de principe :
                      ce qui est monté ici est monté dans le layout *racine*, que `app/error.tsx`
                      ne couvre pas — seul un `global-error.tsx` le ferait, et il n'y en a pas. Une
                      erreur de rendu de l'un d'eux remontait donc jusqu'à la racine et laissait un
                      écran blanc, sans rien à quoi revenir. Isolés, le pire qu'ils puissent faire
                      est de disparaître : le catalogue, lui, reste debout. */}
                  <ErrorBoundary name="lecteur">
                    <PlayerHostLazy />
                  </ErrorBoundary>
                  {/* Sous `SWRProvider` — d'où il lit l'état — et sous `PlaybackProvider`, d'où
                      il apprend qu'un film joue. Les deux lui sont nécessaires, et c'est le seul
                      point de l'arbre qui les a tous les deux. */}
                  <ErrorBoundary name="notices-maintenance">
                    <MaintenanceNotices />
                  </ErrorBoundary>
                  {/* Le banc d'essai du lecteur : rien tant qu'un administrateur ne l'a pas lancé
                      depuis son panneau Compte. Il ouvre et ferme les films par `PlaybackProvider`. */}
                  <ErrorBoundary name="banc-essai">
                    <BenchGate />
                  </ErrorBoundary>
                  {/* « Je suis là », une fois par minute, pour la vue en direct de l'administrateur.
                      Sous `PlaybackProvider`, d'où il apprend ce qui joue. */}
                  <ErrorBoundary name="presence">
                    <PresencePinger />
                  </ErrorBoundary>
                </PlaybackProvider>
              </ToastProvider>
            </SWRProvider>
          </ThemeProvider>
          <UpdateBanner />
          <InstallPrompt />
        </TranslationProvider>
        <ServiceWorkerRegistration />
        <ClientErrorListener />
      </body>
    </html>
  );
}
