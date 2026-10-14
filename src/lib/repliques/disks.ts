import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Sur quel disque physique est un fichier — et seulement quand on peut le **prouver** (DECISIONS.md §88).
 *
 * L'indexation lit une seule chose à la fois. Deux lectures en même temps sur un même disque à
 * plateaux ne vont pas plus vite (la tête fait l'aller-retour entre les deux : mesuré le 14/10/2026),
 * et sur deux disques différents elles vont deux fois plus vite. Le parallélisme n'est donc permis
 * qu'entre fichiers dont on sait qu'ils sont sur des disques physiques distincts — jamais deviné.
 *
 * Deux preuves possibles :
 * - un système de fichiers ordinaire : le périphérique du fichier (`stat().dev`), remonté dans `/sys`
 *   jusqu'au disque entier (une partition → son disque ; un RAID ou un volume LVM → tous ses disques) ;
 * - mergerfs (FUSE, un périphérique virtuel commun à tous les fichiers) : l'attribut étendu
 *   `user.mergerfs.basepath` donne la branche réelle — à condition de pouvoir le lire, et que cette
 *   branche soit elle-même visible dans le conteneur pour en lire le périphérique.
 *
 * Vérifié sur la production le 14/10/2026 : `/mnt/media/video` est un mergerfs de trois branches
 * (16to/video_data, 8to_a, 8to_b — trois disques physiques distincts sur l'hôte), mais **le conteneur
 * ne peut pas lire l'attribut** (ni `getfattr` dans l'image, ni appel `getxattr` dans Node) et les
 * branches n'y sont pas montées. Pas de preuve : une lecture à la fois. C'est voulu.
 */

export interface DiskProbe {
  /** Le système de fichiers d'un chemin, d'après `/proc/self/mountinfo`. */
  fsType(file: string): Promise<string | null>;
  /** L'attribut étendu, ou `null` s'il est illisible. */
  xattr(file: string, name: string): Promise<string | null>;
  /** `major:minor` du périphérique d'un chemin. */
  device(file: string): Promise<string | null>;
  /** Les disques entiers derrière un périphérique `major:minor`, d'après `/sys/dev/block`. */
  physicalDisks(device: string): Promise<string[] | null>;
}

/** Linux encode `dev_t` en 64 bits : majeur et mineur sont répartis en deux morceaux chacun. */
function majorMinor(dev: bigint): string {
  const b = BigInt;
  const major = ((dev >> b(8)) & b(0xfff)) | ((dev >> b(32)) & ~b(0xfff));
  const minor = (dev & b(0xff)) | ((dev >> b(12)) & ~b(0xff));
  return `${major}:${minor}`;
}

async function mountTypeOf(file: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
  let best: { point: string; type: string } | null = null;
  for (const line of text.split("\n")) {
    const parts = line.split(" ");
    const dash = parts.indexOf("-");
    if (parts.length < 10 || dash < 0) continue;
    const point = parts[4].replace(/\\040/g, " ");
    const type = parts[dash + 1];
    if ((file === point || file.startsWith(point.endsWith("/") ? point : point + "/")) && (!best || point.length > best.point.length)) best = { point, type };
  }
  return best?.type ?? null;
}

export const systemProbe: DiskProbe = {
  fsType: mountTypeOf,
  xattr: (file, name) =>
    new Promise((resolve) => {
      // `getfattr` seulement s'il existe : Node n'a pas d'appel `getxattr`, et l'image ne l'installe pas.
      execFile("getfattr", ["--only-values", "--absolute-names", "-n", name, file], { timeout: 3000 }, (error, stdout) => {
        resolve(error || !stdout ? null : String(stdout).trim() || null);
      });
    }),
  device: async (file) => {
    try {
      return majorMinor((await fs.stat(file, { bigint: true })).dev);
    } catch {
      return null;
    }
  },
  physicalDisks: async (device) => {
    const seen = new Set<string>();
    async function resolve(dir: string, depth: number): Promise<boolean> {
      if (depth > 4) return false;
      let real: string;
      try {
        real = await fs.realpath(dir);
      } catch {
        return false;
      }
      // Un volume composé (md, dm) : ses disques sont dans `slaves`.
      try {
        const slaves = await fs.readdir(path.join(real, "slaves"));
        if (slaves.length > 0) {
          for (const slave of slaves) if (!(await resolve(path.join(real, "slaves", slave), depth + 1))) return false;
          return true;
        }
      } catch {
        /* pas un volume composé */
      }
      // Une partition : le disque est le dossier parent.
      try {
        await fs.access(path.join(real, "partition"));
        seen.add(path.basename(path.dirname(real)));
        return true;
      } catch {
        /* un disque entier */
      }
      try {
        await fs.access(path.join(real, "device"));
        seen.add(path.basename(real));
        return true;
      } catch {
        // Ni partition ni disque (un périphérique virtuel : FUSE, overlay, loop sans support) : aucune preuve.
        return false;
      }
    }
    const ok = await resolve(`/sys/dev/block/${device}`, 0);
    return ok && seen.size > 0 ? [...seen].sort() : null;
  },
};

/** Les disques physiques d'un fichier, prouvés — `null` sinon. */
export async function diskOf(file: string, probe: DiskProbe = systemProbe): Promise<string[] | null> {
  let target = file;
  const type = await probe.fsType(file);
  if (type === "fuse.mergerfs") {
    const base = await probe.xattr(file, "user.mergerfs.basepath");
    if (!base) return null;
    target = base;
  } else if (type?.startsWith("fuse")) {
    return null;
  }
  const device = await probe.device(target);
  if (!device) return null;
  return probe.physicalDisks(device);
}

export interface QueuePlan<T> {
  /** Une file par disque prouvé distinct ; une seule file sinon. */
  queues: T[][];
  /** Pourquoi ce nombre de files. */
  reason: "proven" | "single-disk" | "unproven";
}

/**
 * Répartit des fichiers en files de lecture : une par disque **si et seulement si** chaque fichier a
 * un disque prouvé et que ces disques ne se recouvrent pas (un fichier sur un RAID qui partage un
 * disque avec un autre fichier ne peut pas être lu en même temps que lui). Le moindre doute → une
 * seule file, dans l'ordre donné.
 */
export function planQueues<T>(items: readonly T[], disks: readonly (string[] | null)[]): QueuePlan<T> {
  if (items.length === 0) return { queues: [], reason: "single-disk" };
  if (disks.some((d) => !d || d.length === 0)) return { queues: [[...items]], reason: "unproven" };
  const groups = new Map<string, T[]>();
  const keyDisks = new Map<string, string[]>();
  items.forEach((item, i) => {
    const key = disks[i]!.join("+");
    if (!groups.has(key)) {
      groups.set(key, []);
      keyDisks.set(key, disks[i]!);
    }
    groups.get(key)!.push(item);
  });
  // Deux groupes qui partagent un disque : pas de preuve qu'ils peuvent être lus ensemble.
  const owner = new Map<string, string>();
  for (const [key, list] of keyDisks) {
    for (const disk of list) {
      const other = owner.get(disk);
      if (other && other !== key) return { queues: [[...items]], reason: "unproven" };
      owner.set(disk, key);
    }
  }
  const queues = [...groups.values()];
  return { queues, reason: queues.length > 1 ? "proven" : "single-disk" };
}
