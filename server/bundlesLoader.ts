import fs from 'fs';
import path from 'path';

const fsp = fs.promises;

export const BUNDLES_SCHEMA_VERSION = 1;

export class BundlesFileMissingError extends Error {
  constructor(filePath: string) {
    super(
      `bundles.json not found at ${filePath} — regenerate catalog data (requires an M3+ catalog sync)`,
    );
    this.name = 'BundlesFileMissingError';
  }
}

export class BundlesSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundlesSchemaError';
  }
}

export interface BundleDetail {
  version: string | null;
  image: string;
  relatedImages: string[];
}

export interface ChannelEntryDetail {
  name: string;
  replaces?: string;
  skips?: string[];
  skipRange?: string;
}

export interface BundlesPackage {
  bundles: Record<string, BundleDetail>;
  channels: Record<string, ChannelEntryDetail[]>;
}

export interface BundlesFile {
  schemaVersion: number;
  packages: Record<string, BundlesPackage>;
}

export async function loadBundlesFile(
  catalogDir: string,
  catalogType: string,
  version: string,
): Promise<BundlesFile> {
  const filePath = path.join(catalogDir, catalogType, version, 'bundles.json');
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    throw new BundlesFileMissingError(filePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never include file content in the error — bundles.json can contain
    // data derived from the pull secret / catalog contents.
    throw new BundlesSchemaError(`bundles.json is not valid JSON at ${filePath}`);
  }
  const record = parsed as { schemaVersion?: unknown; packages?: unknown };
  if (record?.schemaVersion !== BUNDLES_SCHEMA_VERSION) {
    throw new BundlesSchemaError(
      `Unsupported bundles.json schemaVersion: ${record?.schemaVersion}`,
    );
  }
  if (
    typeof record.packages !== 'object' ||
    record.packages === null ||
    Array.isArray(record.packages)
  ) {
    throw new BundlesSchemaError(
      `bundles.json at ${filePath} is missing a "packages" object`,
    );
  }
  return parsed as BundlesFile;
}
