import { getDb } from "@/lib/db";
import { strictReaderPrefs, type ReaderPrefs } from "@/lib/books/readerPrefs";
import type { ReaderDeviceType } from "@/lib/books/deviceType";

/**
 * Les réglages du lecteur de livres gardés par le serveur (DECISIONS.md §129) — la table
 * `book_reader_prefs`, une ligne par compte et par type d'appareil (`deviceType.ts`).
 *
 * La règle, ici et nulle part ailleurs (`readerPrefsFor`) : un type qui a ses réglages les garde ; un type
 * qui n'en a pas encore prend **les derniers écrits par le compte**, quel que soit leur type. La première
 * fois qu'on règle le lecteur sur un appareil, le réglage vaut donc partout ; dès qu'on le change sur un
 * autre type d'appareil, ce type a le sien. Deux appareils du même type partagent la même ligne.
 *
 * Ils étaient gardés par appareil seulement (`localStorage`, 28/10/2026) : un nouveau téléphone, une
 * session privée ou un navigateur effacé repartaient des réglages par défaut. L'appareil en garde une
 * copie (`laterna:books:reader`) pour ouvrir un livre aussitôt, et sans réseau.
 */

/** Plus long que n'importe quels réglages valides (~250 octets) : au-delà, ce n'est pas le lecteur qui écrit. */
export const MAX_PREFS_BYTES = 2000;

interface Row {
  device_type: ReaderDeviceType;
  prefs: string;
  updated_at: number;
}

export interface StoredReaderPrefs {
  prefs: ReaderPrefs;
  /** `true` : la ligne de ce type ; `false` : celle d'un autre type, la plus récente du compte. */
  own: boolean;
  /** Le type d'où viennent ces réglages. */
  from: ReaderDeviceType;
  updatedAt: number;
}

function parse(row: Row): ReaderPrefs | null {
  try {
    // Relu par la même porte qu'à l'écriture : une ligne d'une version plus ancienne qui ne passe plus
    // n'est pas servie (l'appareil garde alors sa copie).
    return strictReaderPrefs(JSON.parse(row.prefs));
  } catch {
    return null;
  }
}

/** Les réglages de ce compte pour ce type d'appareil, selon la règle ; `null` : le compte n'a rien réglé. */
export function readerPrefsFor(account: string, device: ReaderDeviceType): StoredReaderPrefs | null {
  const rows = getDb()
    .prepare("SELECT device_type, prefs, updated_at FROM book_reader_prefs WHERE account = ? ORDER BY updated_at DESC")
    .all(account) as Row[];
  const own = rows.find((r) => r.device_type === device);
  const pick = own ?? rows[0];
  if (!pick) return null;
  const prefs = parse(pick);
  if (!prefs) return null;
  return { prefs, own: pick === own, from: pick.device_type, updatedAt: pick.updated_at };
}

/**
 * Écrit les réglages de ce type d'appareil. `at` : l'heure du changement, dans l'horloge du serveur — un
 * changement fait hors ligne et renvoyé plus tard n'écrase pas un plus récent fait sur un autre appareil
 * du même type (`kept`).
 */
export function saveReaderPrefs(account: string, device: ReaderDeviceType, prefs: ReaderPrefs, at = Date.now()): { kept: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const held = db.prepare("SELECT updated_at FROM book_reader_prefs WHERE account = ? AND device_type = ?").get(account, device) as { updated_at: number } | undefined;
    if (held && held.updated_at > at) return { kept: true };
    db.prepare(
      `INSERT INTO book_reader_prefs (account, device_type, prefs, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account, device_type) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`
    ).run(account, device, JSON.stringify(prefs), at);
    return { kept: false };
  })();
}
