import { compareVersionStrings } from '../utils.js';
import { parseCsvName } from './csvName.js';
import { extractClusterVersion } from './client.js';
import type {
  AcmHub,
  AliasLookup,
  CatalogLookup,
  ClusterInfo,
  ClusterSearchItem,
  CsvSearchItem,
  DeployedOperatorSnapshot,
  HubSnapshotStatus,
  PackageSnapshot,
  PackageStatus,
} from './types.js';

export interface HubFetchOutcome {
  hub: AcmHub;
  status: 'ok' | 'error';
  error?: string;
  items?: CsvSearchItem[];
  clusterItems?: ClusterSearchItem[];
  truncated?: boolean;
}

export interface CatalogOperatorLike {
  name: string;
  availableVersions?: string[];
  maxVersion?: string | null;
  catalog?: string;
  defaultChannel?: string;
  channelVersions?: Record<string, string[]>;
  csvNamePrefixes?: string[];
}

export interface CatalogDataLike {
  operators: Record<string, CatalogOperatorLike[]>;
}

const SEMVERISH = /^\d+(\.\d+)+/;

function isSemverish(version: string): boolean {
  return SEMVERISH.test(version);
}

export function buildCatalogLookup(
  data: CatalogDataLike | null,
): CatalogLookup {
  const lookup: CatalogLookup = new Map();
  if (!data?.operators) {
    return lookup;
  }
  for (const operators of Object.values(data.operators)) {
    for (const op of operators) {
      const versions = op.availableVersions?.length
        ? op.availableVersions
        : op.maxVersion
          ? [op.maxVersion]
          : [];
      if (!versions.length) {
        continue;
      }
      const latest = versions.reduce((a, b) =>
        compareVersionStrings(a, b) >= 0 ? a : b,
      );
      const existing = lookup.get(op.name);
      if (
        !existing ||
        compareVersionStrings(latest, existing.latestAvailable) > 0
      ) {
        lookup.set(op.name, {
          latestAvailable: latest,
          catalogSource: op.catalog ?? 'unknown',
        });
      }
    }
  }
  return lookup;
}

export function buildAliasLookup(data: CatalogDataLike | null): AliasLookup {
  const aliases: AliasLookup = new Map();
  if (!data?.operators) {
    return aliases;
  }
  const packageNames = new Set<string>();
  for (const operators of Object.values(data.operators)) {
    for (const op of operators) {
      packageNames.add(op.name);
    }
  }
  const ambiguous = new Set<string>();
  for (const operators of Object.values(data.operators)) {
    for (const op of operators) {
      for (const prefix of op.csvNamePrefixes ?? []) {
        if (!prefix || prefix === op.name) {
          continue;
        }
        const existing = aliases.get(prefix);
        if (existing !== undefined && existing !== op.name) {
          ambiguous.add(prefix);
          continue;
        }
        aliases.set(prefix, op.name);
      }
    }
  }
  for (const prefix of ambiguous) {
    // A prefix equal to a real package name is dropped silently below —
    // that rule takes priority over the ambiguity warning.
    if (!packageNames.has(prefix)) {
      console.warn(
        `ACM alias map: CSV prefix "${prefix}" is claimed by multiple packages — dropped`,
      );
    }
    aliases.delete(prefix);
  }
  for (const prefix of aliases.keys()) {
    if (packageNames.has(prefix)) {
      aliases.delete(prefix); // a literal package name always wins
    }
  }
  return aliases;
}

export function buildSnapshot(
  outcomes: HubFetchOutcome[],
  catalog: CatalogLookup,
  refreshedAt: string,
): DeployedOperatorSnapshot {
  const hubs: HubSnapshotStatus[] = [];
  const packages: Record<string, PackageSnapshot> = {};
  const allClusters: ClusterInfo[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === 'error') {
      hubs.push({
        id: outcome.hub.id,
        name: outcome.hub.name,
        status: 'error',
        error: outcome.error ?? 'unknown error',
        truncated: false,
        skippedItems: 0,
        clusterCount: 0,
      });
      continue;
    }

    const seen = new Set<string>();
    const clusters = new Set<string>();
    let skipped = 0;

    for (const item of outcome.items ?? []) {
      if (
        !item ||
        typeof item.name !== 'string' ||
        typeof item.cluster !== 'string' ||
        typeof item.phase !== 'string'
      ) {
        skipped++;
        continue;
      }
      if (item.phase !== 'Succeeded') {
        continue;
      }
      const dedupKey = `${item.cluster} ${item.name}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      const parsed = parseCsvName(item.name);
      if (!parsed) {
        skipped++;
        continue;
      }
      clusters.add(item.cluster);
      let pkg = packages[parsed.packageName];
      if (!pkg) {
        pkg = {
          deployments: [],
          minDeployed: parsed.version,
          maxDeployed: parsed.version,
          latestAvailable: null,
          catalogSource: null,
          status: 'unknown',
        };
        packages[parsed.packageName] = pkg;
      }
      pkg.deployments.push({
        cluster: item.cluster,
        hub: outcome.hub.name,
        version: parsed.version,
        behind: false,
      });
    }

    const clusterSeen = new Set<string>();
    for (const clusterItem of outcome.clusterItems ?? []) {
      if (!clusterItem || typeof clusterItem.name !== 'string' || !clusterItem.name) {
        skipped++;
        continue;
      }
      const clusterKey = `${outcome.hub.name} ${clusterItem.name}`;
      if (clusterSeen.has(clusterKey)) {
        continue;
      }
      clusterSeen.add(clusterKey);
      clusters.add(clusterItem.name);
      const version = extractClusterVersion(clusterItem);
      if (!version) {
        skipped++;
        continue;
      }
      allClusters.push({
        cluster: clusterItem.name,
        hub: outcome.hub.name,
        openshiftVersion: version,
      });
    }

    hubs.push({
      id: outcome.hub.id,
      name: outcome.hub.name,
      status: 'ok',
      error: null,
      truncated: Boolean(outcome.truncated),
      skippedItems: skipped,
      clusterCount: clusters.size,
    });
  }

  for (const [name, pkg] of Object.entries(packages)) {
    pkg.deployments.sort((a, b) => compareVersionStrings(a.version, b.version));
    pkg.minDeployed = pkg.deployments[0].version;
    pkg.maxDeployed = pkg.deployments[pkg.deployments.length - 1].version;

    const info = catalog.get(name);
    if (!info || !isSemverish(info.latestAvailable)) {
      pkg.status = 'unknown';
      continue;
    }
    pkg.latestAvailable = info.latestAvailable;
    pkg.catalogSource = info.catalogSource;

    let status: PackageStatus = 'current';
    for (const deployment of pkg.deployments) {
      deployment.behind =
        compareVersionStrings(deployment.version, info.latestAvailable) < 0;
      if (deployment.behind) {
        status = 'behind';
      }
    }
    pkg.status = status;
  }

  allClusters.sort(
    (a, b) => a.cluster.localeCompare(b.cluster) || a.hub.localeCompare(b.hub),
  );
  return { schemaVersion: 2, refreshedAt, hubs, clusters: allClusters, packages };
}
