"use client";

// Ce que l'écran dit d'un refus, dans la langue du compte. Les routes des signalements renvoient
// un code (`reportError`, reportRequest.ts) ; le téléphone en pose aussi quelques-uns avant
// d'envoyer (`appendImages`). Un code inconnu, une panne réseau : la phrase générique.

const KNOWN = new Set([
  "unauthenticated",
  "notFound",
  "form",
  "notImage",
  "tooLarge",
  "tooMany",
  "empty",
  "notDraft",
  "draftNoComment",
  "refused",
  "incomplete",
  "requestTooLarge",
  "quota",
]);

export function reportErrorText(error: unknown, t: (key: string) => string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && KNOWN.has(code) ? t(`report.errors.${code}`) : t("report.ui.failed");
}
