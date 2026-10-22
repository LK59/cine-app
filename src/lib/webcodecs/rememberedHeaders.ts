import type { MatroskaFile } from "./matroska";

/**
 * Les en-têtes lus récemment, sous la clé de leur fichier, les plus anciens oubliés d'abord.
 *
 * `parseMatroska` et `parseMp4` en tenaient chacun une copie ligne pour ligne (même carte, même
 * plafond, même éviction) ; elles ne diffèrent que par leur lecteur. La fabrique ne garde que la
 * carte : la lecture, son `await` et le contrôle de taille (`segmentEnd <= source.size`) restent chez
 * chaque appelant, à leur place d'avant.
 *
 * Ni rafraîchie à la lecture ni plus maligne qu'avant : `containers` (`mediaFile.ts`), qui remet
 * l'entrée relue en tête, est une autre règle et n'est pas fabriquée ici.
 */
export function rememberedHeaders(max: number) {
  const parsed = new Map<string, MatroskaFile>();
  return {
    get(key: string): MatroskaFile | undefined {
      return parsed.get(key);
    },
    forget(key: string): void {
      parsed.delete(key);
    },
    remember(key: string, file: MatroskaFile): void {
      parsed.set(key, file);
      while (parsed.size > max) {
        const oldest = parsed.keys().next().value;
        if (oldest === undefined) break;
        parsed.delete(oldest);
      }
    },
  };
}
