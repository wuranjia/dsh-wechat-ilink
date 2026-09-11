import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JsonFileBridgeStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wechat-store-"));
});

describe("JsonFileBridgeStore", () => {
  it("loads empty state when the file is missing", async () => {
    const store = new JsonFileBridgeStore(join(dir, "state.json"));
    await store.load();
    expect(await store.get("u1")).toBeUndefined();
  });

  it("round-trips set entries across instances", async () => {
    const file = join(dir, "state.json");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    await store.set("u1", { sessionId: "wechat-a", lastActiveMs: 123 });
    await store.set("u2", { sessionId: "wechat-b", lastActiveMs: 456 });

    const reloaded = new JsonFileBridgeStore(file);
    await reloaded.load();
    expect(await reloaded.get("u1")).toEqual({ sessionId: "wechat-a", lastActiveMs: 123 });
    expect(await reloaded.get("u2")).toEqual({ sessionId: "wechat-b", lastActiveMs: 456 });
  });

  it("delete removes the entry durably", async () => {
    const file = join(dir, "state.json");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    await store.set("u1", { sessionId: "wechat-a", lastActiveMs: 123 });
    await store.delete("u1");
    expect(await store.get("u1")).toBeUndefined();

    const reloaded = new JsonFileBridgeStore(file);
    await reloaded.load();
    expect(await reloaded.get("u1")).toBeUndefined();
  });

  it("tolerates a corrupt file by starting empty", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, "{not json", "utf8");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    expect(await store.get("u1")).toBeUndefined();
  });

  it("skips invalid records but keeps valid ones", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify({
      good: { sessionId: "wechat-a", lastActiveMs: 1 },
      badNoSession: { lastActiveMs: 2 },
      badNotObject: 42,
    }), "utf8");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    expect(await store.get("good")).toEqual({ sessionId: "wechat-a", lastActiveMs: 1 });
    expect(await store.get("badNoSession")).toBeUndefined();
    expect(await store.get("badNotObject")).toBeUndefined();
  });

  it("writes the state file under the store directory", async () => {
    const file = join(dir, "state.json");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    await store.set("u1", { sessionId: "wechat-a", lastActiveMs: 7 });
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.u1).toEqual({ sessionId: "wechat-a", lastActiveMs: 7 });
  });
});
