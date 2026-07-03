import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { SWRProvider } from "@/components/SWRProvider";
import { ToastProvider } from "@/components/Toast";

export const metadata: Metadata = {
  title: "Cine App",
  description: "Tableau de bord unifié pour la stack média",
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
  themeColor: "#020617",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="dark">
      <body>
        <SWRProvider>
          <ToastProvider>{children}</ToastProvider>
        </SWRProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
