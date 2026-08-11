// DocumentStore adapters.
//
// Content-addressed: the key IS the hash, so writing the same bytes twice is a
// no-op and two candidates sharing a CV share one blob.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentStore } from '../application/ports.js';

/** Development and test default. Not for production — no replication, no ACLs. */
export class FilesystemDocumentStore implements DocumentStore {
  constructor(private readonly root: string) {}

  private pathFor(fileHash: string): string {
    if (!/^[a-f0-9]{32,128}$/i.test(fileHash)) {
      // The hash becomes a path segment; anything else is a traversal.
      throw new Error(`Refusing to use "${fileHash}" as a storage key.`);
    }
    // Two-level fan-out: a flat directory with 100k CVs is slow to list on most
    // filesystems and unpleasant to back up.
    return path.join(this.root, fileHash.slice(0, 2), fileHash.slice(2, 4), fileHash);
  }

  async put(input: { fileHash: string; bytes: Uint8Array }): Promise<{ storageKey: string }> {
    const target = this.pathFor(input.fileHash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Same hash means same bytes, so an existing file needs no rewrite.
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, input.bytes);
    }
    return { storageKey: input.fileHash };
  }

  async get(fileHash: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.pathFor(fileHash)));
    } catch {
      return null;
    }
  }

  async delete(fileHash: string): Promise<void> {
    await fs.rm(this.pathFor(fileHash), { force: true });
  }
}

/** In-memory. Tests, and a deployment that has not configured storage yet. */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(input: { fileHash: string; bytes: Uint8Array }): Promise<{ storageKey: string }> {
    if (!this.blobs.has(input.fileHash)) this.blobs.set(input.fileHash, input.bytes);
    return { storageKey: input.fileHash };
  }

  async get(fileHash: string): Promise<Uint8Array | null> {
    return this.blobs.get(fileHash) ?? null;
  }

  async delete(fileHash: string): Promise<void> {
    this.blobs.delete(fileHash);
  }

  get size(): number { return this.blobs.size; }
}
