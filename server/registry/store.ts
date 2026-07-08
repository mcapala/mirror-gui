import fs from 'fs';
import path from 'path';
import type { MirrorRegistryConfig, RegistryScanSnapshot } from './types.js';

const fsp = fs.promises;

export const SCAN_SCHEMA_VERSION = 2;

export class ScanSnapshotSchemaError extends Error {
  constructor(found: unknown) {
    super(`Unsupported scan snapshot schemaVersion: ${found}`);
    this.name = 'ScanSnapshotSchemaError';
  }
}

export class RegistryStore {
  constructor(private readonly storageDir: string) {}

  private registriesPath(): string {
    return path.join(this.storageDir, 'registries.json');
  }

  private scanPath(id: string): string {
    return path.join(this.storageDir, 'registry-scans', `${id}.json`);
  }

  async readRegistries(): Promise<MirrorRegistryConfig[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.registriesPath(), 'utf8');
    } catch {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.registries) ? parsed.registries : [];
  }

  async writeRegistries(registries: MirrorRegistryConfig[]): Promise<void> {
    // May hold registry passwords — owner-only, like the ACM hub token store.
    await this.atomicWrite(
      this.registriesPath(),
      JSON.stringify({ registries }, null, 2),
      0o600,
    );
  }

  async readScan(id: string): Promise<RegistryScanSnapshot | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.scanPath(id), 'utf8');
    } catch {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== SCAN_SCHEMA_VERSION) {
      throw new ScanSnapshotSchemaError(parsed?.schemaVersion);
    }
    return parsed as RegistryScanSnapshot;
  }

  async writeScan(snapshot: RegistryScanSnapshot): Promise<void> {
    await this.atomicWrite(
      this.scanPath(snapshot.registryId),
      JSON.stringify(snapshot, null, 2),
    );
  }

  async deleteScan(id: string): Promise<void> {
    await fsp.rm(this.scanPath(id), { force: true });
  }

  private async atomicWrite(
    dest: string,
    content: string,
    mode: number = 0o644,
  ): Promise<void> {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    await fsp.writeFile(tmp, content, { mode });
    // writeFile's mode only applies on creation — enforce it even when a
    // stale tmp file (or a pre-credentials 0644 store) is being replaced.
    await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, dest);
  }
}
