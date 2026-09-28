import type { DirHandleLike, FileHandleLike } from "@/lib/resumeCache/store";

/**
 * Un système de fichiers privé (OPFS) en mémoire : des dossiers, des fichiers, `createWritable` en
 * option — pour éprouver aussi l'écriture de repli, celle des Safari qui n'ont que
 * `createSyncAccessHandle` dans un worker.
 */
export class FakeDir implements DirHandleLike {
  /** L'horloge des dates de fichiers — `sweepResumeStore` épargne ce qui est récent. */
  static now: () => number = () => Date.now();
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, Uint8Array>();
  readonly modified = new Map<string, number>();

  /** Les noms du dossier, comme `FileSystemDirectoryHandle.keys()`. */
  async *keys(): AsyncIterable<string> {
    for (const name of [...this.dirs.keys(), ...this.files.keys()]) yield name;
  }
  /**
   * @param wholeBuffer écrire, d'une vue, tout le tampon qu'elle regarde — ce qu'a fait Safari le
   *   28/09/2026 (voir `exactBytes`). Par défaut, la vue seule, comme le veut la spécification.
   */
  constructor(
    private readonly writable = true,
    private readonly wholeBuffer = false
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new DOMException("absent", "NotFoundError");
      dir = new FakeDir(this.writable, this.wholeBuffer);
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("absent", "NotFoundError");
      this.files.set(name, new Uint8Array(0));
    }
    const files = this.files;
    const modified = this.modified;
    const wholeBuffer = this.wholeBuffer;
    const handle: FileHandleLike = {
      getFile: async () => new File([files.get(name)! as BlobPart], name, { lastModified: modified.get(name) ?? FakeDir.now() }),
    };
    if (this.writable) {
      handle.createWritable = async () => {
        const parts: Uint8Array[] = [];
        return {
          write: async (data: BufferSource | string) => {
            const view = data as ArrayBufferView;
            parts.push(
              typeof data === "string"
                ? new TextEncoder().encode(data)
                : data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : wholeBuffer
                    ? new Uint8Array(view.buffer.slice(0))
                    : new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
            );
          },
          close: async () => {
            const total = parts.reduce((n, p) => n + p.length, 0);
            const out = new Uint8Array(total);
            let at = 0;
            for (const p of parts) {
              out.set(p, at);
              at += p.length;
            }
            files.set(name, out);
            modified.set(name, FakeDir.now());
          },
        };
      };
    }
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.dirs.delete(name) && !this.files.delete(name)) throw new DOMException("absent", "NotFoundError");
  }

  /** Suit un chemin jusqu'à un fichier, pour l'écriture de repli. */
  writeAt(path: string[], data: Uint8Array): void {
    let dir: FakeDir = this;
    for (const part of path.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = new FakeDir(this.writable);
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(path[path.length - 1], data.slice());
    dir.modified.set(path[path.length - 1], FakeDir.now());
  }
}
