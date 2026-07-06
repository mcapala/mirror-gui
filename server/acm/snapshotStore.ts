import fs from 'fs';
import path from 'path';
import type { AcmHub, DeployedOperatorSnapshot } from './types.js';

const fsp = fs.promises;

export const SNAPSHOT_SCHEMA_VERSION = 2;

export class SnapshotSchemaError extends Error {
  constructor(found: unknown) {
    super(`Unsupported snapshot schemaVersion: ${found}`);
    this.name = 'SnapshotSchemaError';
  }
}

export class AcmStore {
  constructor(private readonly acmDir: string) {}

  private hubsPath(): string {
    return path.join(this.acmDir, 'hubs.json');
  }

  private snapshotPath(): string {
    return path.join(this.acmDir, 'snapshot.json');
  }

  async readHubs(): Promise<AcmHub[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.hubsPath(), 'utf8');
    } catch {
      return [];
    }
    return JSON.parse(raw);
  }

  async writeHubs(hubs: AcmHub[]): Promise<void> {
    await this.atomicWrite(
      this.hubsPath(),
      JSON.stringify(hubs, null, 2),
      0o600,
    );
  }

  async readSnapshot(): Promise<DeployedOperatorSnapshot | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.snapshotPath(), 'utf8');
    } catch {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      throw new SnapshotSchemaError(parsed?.schemaVersion);
    }
    return parsed as DeployedOperatorSnapshot;
  }

  async writeSnapshot(snapshot: DeployedOperatorSnapshot): Promise<void> {
    await this.atomicWrite(
      this.snapshotPath(),
      JSON.stringify(snapshot, null, 2),
      0o644,
    );
  }

  private async atomicWrite(
    dest: string,
    content: string,
    mode: number,
  ): Promise<void> {
    await fsp.mkdir(this.acmDir, { recursive: true });
    const tmp = `${dest}.tmp`;
    await fsp.writeFile(tmp, content, { mode });
    await fsp.rename(tmp, dest);
  }
}
