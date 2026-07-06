import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AcmStore, SnapshotSchemaError } from '../../server/acm/snapshotStore.js';
import type {
  AcmHub,
  DeployedOperatorSnapshot,
} from '../../server/acm/types.js';

const HUB: AcmHub = {
  id: 'hub-1',
  name: 'prod',
  url: 'https://search.example.com',
  token: 'sha256~secret',
};

const SNAPSHOT: DeployedOperatorSnapshot = {
  schemaVersion: 2,
  refreshedAt: '2026-07-06T12:00:00.000Z',
  hubs: [],
  clusters: [],
  packages: {},
};

describe('AcmStore', () => {
  let dir: string;
  let store: AcmStore;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'acm-store-'));
    store = new AcmStore(path.join(dir, 'acm'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('returns empty hubs list when nothing stored', async () => {
    expect(await store.readHubs()).toEqual([]);
  });

  it('round-trips hubs and writes hubs.json with mode 0600', async () => {
    await store.writeHubs([HUB]);
    expect(await store.readHubs()).toEqual([HUB]);
    const stat = await fs.promises.stat(path.join(dir, 'acm', 'hubs.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('returns null snapshot before first refresh', async () => {
    expect(await store.readSnapshot()).toBeNull();
  });

  it('round-trips a snapshot', async () => {
    await store.writeSnapshot(SNAPSHOT);
    expect(await store.readSnapshot()).toEqual(SNAPSHOT);
  });

  it('rejects a snapshot with an unsupported schemaVersion', async () => {
    await store.writeSnapshot(SNAPSHOT);
    const file = path.join(dir, 'acm', 'snapshot.json');
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    raw.schemaVersion = 99;
    await fs.promises.writeFile(file, JSON.stringify(raw));
    await expect(store.readSnapshot()).rejects.toThrow(/schemaVersion/);
  });

  it('throws SnapshotSchemaError on schemaVersion mismatch', async () => {
    await fs.promises.mkdir(path.join(dir, 'acm'), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'acm', 'snapshot.json'),
      JSON.stringify({ schemaVersion: 999 }),
    );
    await expect(store.readSnapshot()).rejects.toBeInstanceOf(SnapshotSchemaError);
  });

  it('does not leave a .tmp file behind after writing', async () => {
    await store.writeSnapshot(SNAPSHOT);
    const entries = await fs.promises.readdir(path.join(dir, 'acm'));
    expect(entries.filter(e => e.endsWith('.tmp'))).toEqual([]);
  });

  it('propagates corruption of hubs.json instead of returning []', async () => {
    await store.writeHubs([HUB]);
    await fs.promises.writeFile(
      path.join(dir, 'acm', 'hubs.json'),
      'not-json{'
    );
    await expect(store.readHubs()).rejects.toThrow();
  });
});
