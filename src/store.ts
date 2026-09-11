import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Durable per-user bridge state. */
export interface StoredUserState {
  sessionId: string;
  lastActiveMs: number;
}

export interface BridgeStore {
  get(userId: string): Promise<StoredUserState | undefined>;
  set(userId: string, state: StoredUserState): Promise<void>;
  delete(userId: string): Promise<void>;
}

/** JSON-file backed BridgeStore; call load() once before use. */
export class JsonFileBridgeStore implements BridgeStore {
  private readonly cache = new Map<string, StoredUserState>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return; // missing file → start empty
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file → start empty
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.sessionId !== "string" || record.sessionId === "") continue;
      if (typeof record.lastActiveMs !== "number" || !Number.isSafeInteger(record.lastActiveMs)) continue;
      this.cache.set(userId, { sessionId: record.sessionId, lastActiveMs: record.lastActiveMs });
    }
  }

  async get(userId: string): Promise<StoredUserState | undefined> {
    return this.cache.get(userId);
  }

  async set(userId: string, state: StoredUserState): Promise<void> {
    this.cache.set(userId, state);
    await this.persist();
  }

  async delete(userId: string): Promise<void> {
    this.cache.delete(userId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const record: Record<string, StoredUserState> = {};
    for (const [userId, state] of this.cache) record[userId] = state;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
}
