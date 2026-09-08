import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ArtifactRef } from '@repropath/protocol';
export const artifactDirectory = () => process.env.REPROPATH_ARTIFACT_DIR ?? join(homedir(), '.repropath', 'artifacts');
export const validArtifactId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export interface ArtifactStore { put(kind: ArtifactRef['kind'], data: Buffer): Promise<ArtifactRef>; read(id: string): Promise<Buffer>; }
export class LocalArtifactStore implements ArtifactStore {
  private static tail: Promise<unknown> = Promise.resolve();
  private static pending = 0;
  constructor(private directory = artifactDirectory(), private maxBytes = 2 * 1024 * 1024 * 1024) {}
  async put(kind: ArtifactRef['kind'], data: Buffer): Promise<ArtifactRef> {
    if (LocalArtifactStore.pending >= 64) throw new Error('Artifact queue full');
    LocalArtifactStore.pending++;
    const result = LocalArtifactStore.tail.then(() => this.write(kind, data)).finally(() => { LocalArtifactStore.pending--; });
    LocalArtifactStore.tail = result.catch(() => {}); return result;
  }
  private async write(kind: ArtifactRef['kind'], data: Buffer): Promise<ArtifactRef> {
    const id = randomUUID(); const temp = join(this.directory, `${id}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      // Includes retained files from prior processes: closing/restarting cannot evade disk bounds.
      const names = await readdir(this.directory);
      if (names.length >= 50_000) throw new Error();
      let used = 0;
      for (const name of names) { if (validArtifactId(name) || name.endsWith('.tmp')) used += (await stat(join(this.directory, name))).size; }
      if (used + data.length > this.maxBytes) throw new Error();
      await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      await rename(temp, join(this.directory, id));
      return { id, kind, contentType: kind === 'screenshot' ? 'image/jpeg' : 'text/plain; charset=utf-8', byteLength: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    } catch { await unlink(temp).catch(() => {}); throw new Error('Artifact write failed'); }
  }
  async read(id: string): Promise<Buffer> {
    if (!validArtifactId(id)) throw new Error('Unknown artifact');
    return readFile(join(this.directory, id));
  }
}
