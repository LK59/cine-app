/**
 * Un IndexedDB en mémoire, juste ce que `persistentCache.ts` en utilise : ouvrir avec montée de
 * version, un magasin à clé composée, `getAll`, `put`, `delete`, `clear`, et des transactions qui
 * se terminent. Asynchrone comme le vrai — chaque résultat arrive au tour suivant —, et clonant
 * ce qu'il range, comme le vrai : un objet relu n'est jamais celui qu'on a écrit.
 */

type Row = Record<string, unknown>;

class FakeRequest<T> {
  result: T | undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeStore {
  constructor(
    private readonly rows: Map<string, Row>,
    private readonly keyPath: string[],
    private readonly tx: FakeTransaction
  ) {}

  private keyOf(value: Row | unknown[]): string {
    return JSON.stringify(Array.isArray(value) ? value : this.keyPath.map((k) => (value as Row)[k]));
  }

  private request<T>(run: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.tx.pending += 1;
    setTimeout(() => {
      try {
        request.result = run();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
      this.tx.settle();
    }, 0);
    return request;
  }

  getAll() {
    return this.request(() => [...this.rows.values()].map((row) => structuredClone(row)));
  }
  put(value: Row) {
    return this.request(() => void this.rows.set(this.keyOf(value), structuredClone(value)));
  }
  delete(key: unknown[]) {
    return this.request(() => void this.rows.delete(this.keyOf(key)));
  }
  clear() {
    return this.request(() => void this.rows.clear());
  }
}

class FakeTransaction {
  pending = 0;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private readonly db: FakeDatabase) {
    // Une transaction sans requête se termine aussitôt, comme la vraie.
    setTimeout(() => this.settle(), 0);
  }
  objectStore(name: string) {
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`NotFoundError: ${name}`);
    return new FakeStore(store.rows, store.keyPath, this);
  }
  settle() {
    if (this.pending > 0) this.pending -= 1;
    if (this.pending === 0) setTimeout(() => this.oncomplete?.(), 0);
  }
}

class FakeDatabase {
  stores = new Map<string, { rows: Map<string, Row>; keyPath: string[] }>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string, options: { keyPath: string[] }) {
    this.stores.set(name, { rows: new Map(), keyPath: options.keyPath });
  }
  transaction() {
    return new FakeTransaction(this);
  }
}

export function fakeIndexedDb() {
  const databases = new Map<string, FakeDatabase>();
  return {
    databases,
    open(name: string) {
      const request = new FakeRequest<FakeDatabase>();
      setTimeout(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) {
          db = new FakeDatabase();
          databases.set(name, db);
        }
        request.result = db;
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}
