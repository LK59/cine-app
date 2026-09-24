"use client";

import { MAX_IMAGE_BYTES, MAX_REQUEST_BYTES } from "@/lib/reportLimits";
import { withCode } from "@/lib/upstreamError";

/** Le plus grand côté de la version d'affichage : le serveur ne garde jamais plus grand. */
const SHOWN_MAX_SIDE = 2560;

/**
 * Préparer une capture avant l'envoi : l'original part toujours, et, pour un format que le serveur
 * ne sait pas lire — le HEIC des iPhone surtout —, une version JPEG faite ici, par le navigateur
 * qui, lui, sait l'afficher. Faute de pouvoir la décoder non plus, l'original part seul : le
 * serveur le garde, et le ticket propose de le télécharger.
 */
const READABLE = /^image\/(jpe?g|png|webp|gif|avif)$/i;
const READABLE_NAME = /\.(jpe?g|png|webp|gif|avif)$/i;

export async function prepareReportImage(file: File): Promise<{ original: File; shown: File | null }> {
  if (READABLE.test(file.type) || READABLE_NAME.test(file.name)) return { original: file, shown: null };
  try {
    const bitmap = await createImageBitmap(file);
    // Réduite ici plutôt qu'au serveur : une photo HEIC de 48 Mpx devenait un JPEG pleine taille
    // envoyé à côté de l'original, et deux photos suffisaient à dépasser ce qu'une requête porte.
    const scale = Math.min(1, SHOWN_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) return { original: file, shown: null };
    return { original: file, shown: new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }) };
  } catch {
    return { original: file, shown: null };
  }
}

/**
 * Les images d'un envoi, dans le formulaire : `images` et `shown` au même rang (vide s'il n'y a
 * rien). Refusé ici, avec le code que l'écran traduit, ce que le serveur refuserait de toute façon :
 * savoir qu'une photo est trop lourde ne doit pas coûter son envoi sur un réseau mobile.
 */
export async function appendImages(form: FormData, files: File[]): Promise<void> {
  let total = 0;
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) throw withCode(new Error(`« ${file.name} » dépasse 25 Mo`), "tooLarge");
    const { original, shown } = await prepareReportImage(file);
    total += original.size + (shown?.size ?? 0);
    if (total > MAX_REQUEST_BYTES) throw withCode(new Error("Envoi trop lourd"), "requestTooLarge");
    form.append("images", original);
    form.append("shown", shown ?? new File([], "vide"));
  }
}

/** Ce que le navigateur dit de lui, pour aider à comprendre un signalement. */
export function reportContext(locale: string): Record<string, unknown> {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    lang: locale,
    url: window.location.hash.slice(0, 300),
    screen: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x`,
    width: window.innerWidth,
    height: window.innerHeight,
    standalone: window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true,
    online: navigator.onLine,
    build: `${process.env.NEXT_PUBLIC_APP_VERSION ?? "?"}+${process.env.NEXT_PUBLIC_APP_BUILD ?? "?"}`,
  };
}
