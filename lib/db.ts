"use client";

import { emptySave, Save, World } from "./types";

const DB_NAME = "wenyou";
const DB_VERSION = 3;
const WORLDS = "worlds";
const SAVES = "saves";
const VOICES = "voices";
const FAVS = "favorites";

// 语音缓存最多留这么多句，超了先丢最早合成的
const VOICE_KEEP = 240;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB() {
  if (typeof window === "undefined") throw new Error("no indexeddb");
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(WORLDS)) {
          db.createObjectStore(WORLDS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SAVES)) {
          db.createObjectStore(SAVES, { keyPath: "worldId" });
        }
        if (!db.objectStoreNames.contains(VOICES)) {
          db.createObjectStore(VOICES, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(FAVS)) {
          db.createObjectStore(FAVS, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listWorlds(): Promise<World[]> {
  const all = await tx<World[]>(WORLDS, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getWorld(id: string): Promise<World | undefined> {
  return tx<World | undefined>(WORLDS, "readonly", (s) => s.get(id));
}

export async function getSaves(): Promise<Save[]> {
  return tx<Save[]>(SAVES, "readonly", (s) => s.getAll());
}

export async function putWorld(world: World): Promise<void> {
  world.updatedAt = Date.now();
  await tx(WORLDS, "readwrite", (s) => s.put(world));
}

export async function deleteWorld(id: string): Promise<void> {
  await tx(WORLDS, "readwrite", (s) => s.delete(id));
  await tx(SAVES, "readwrite", (s) => s.delete(id));
}

export async function getSave(worldId: string): Promise<Save> {
  const existing = await tx<Save | undefined>(SAVES, "readonly", (s) => s.get(worldId));
  if (existing) return existing;
  const save = emptySave(worldId);
  await tx(SAVES, "readwrite", (s) => s.put(save));
  return save;
}

export async function putSave(save: Save): Promise<void> {
  save.updatedAt = Date.now();
  await tx(SAVES, "readwrite", (s) => s.put(save));
}

type VoiceClip = {
  key: string;
  blob: Blob;
  at: number;
};

export async function getVoiceClip(key: string): Promise<Blob | undefined> {
  const row = await tx<VoiceClip | undefined>(VOICES, "readonly", (s) => s.get(key));
  return row?.blob;
}

export async function putVoiceClip(key: string, blob: Blob): Promise<void> {
  await tx(VOICES, "readwrite", (s) => s.put({ key, blob, at: Date.now() } satisfies VoiceClip));
  const count = await tx<number>(VOICES, "readonly", (s) => s.count());
  if (count <= VOICE_KEEP) return;
  const all = await tx<VoiceClip[]>(VOICES, "readonly", (s) => s.getAll());
  all.sort((a, b) => a.at - b.at);
  const drop = all.slice(0, all.length - VOICE_KEEP);
  await Promise.all(drop.map((d) => tx(VOICES, "readwrite", (s) => s.delete(d.key))));
}

// 收藏的句子：音频原样存一份，语音缓存清了也不会跟着没掉
export type Favorite = {
  key: string;
  worldId: string;
  worldTitle: string;
  speaker: string;
  text: string;
  blob: Blob;
  at: number;
};

export async function listFavorites(worldId?: string): Promise<Favorite[]> {
  const all = await tx<Favorite[]>(FAVS, "readonly", (s) => s.getAll());
  return all
    .filter((f) => !worldId || f.worldId === worldId)
    .sort((a, b) => b.at - a.at);
}

export async function putFavorite(fav: Favorite): Promise<void> {
  await tx(FAVS, "readwrite", (s) => s.put(fav));
}

export async function deleteFavorite(key: string): Promise<void> {
  await tx(FAVS, "readwrite", (s) => s.delete(key));
}
