import { compareVersionStrings } from '../utils.js';
import type { DeployedOperatorSnapshot } from './types.js';

// --- Types (see plan Interfaces block; copy verbatim) ---

export type SuggestionKind =
  | 'raise-min-version'
  | 'lower-min-version-drift'
  | 'raise-platform-min-version'
  | 'add-channel'
  | 'add-operator'
  | 'remove-channel'
  | 'reset-unused-operator';

export type SuggestionPath =
  | { type: 'operator-channel'; catalog: string; package: string; channel: string }
  | { type: 'operator'; catalog: string; package: string }
  | { type: 'platform-channel'; channel: string };

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  path: SuggestionPath;
  current: string | null;
  proposed: string | null;
  proposedChannels?: { name: string; minVersion: string }[];
  evidence: string;
  defaultChecked: boolean;
}

export interface BehindReportEntry {
  package: string;
  latestAvailable: string | null;
  behindClusters: { cluster: string; hub: string; version: string }[];
}

export interface NoDataEntry {
  package: string;
  reason: 'no-fleet-data' | 'not-in-catalog' | 'catalog-unavailable';
}

export interface ReconcileResult {
  suggestions: Suggestion[];
  report: BehindReportEntry[];
  noData: NoDataEntry[];
  warnings: string[];
}

export interface CatalogOperatorDetail {
  defaultChannel: string | null;
  channelVersions: Record<string, string[]>;
}

export type ReconcileCatalog = Map<string, Map<string, CatalogOperatorDetail>>;

export interface IscOperatorChannel { name: string; minVersion?: string }

export interface IscOperatorPackage { name: string; channels?: IscOperatorChannel[] }

export interface IscOperatorCatalog { catalog: string; packages?: IscOperatorPackage[] }

export interface IscPlatformChannel { name: string; minVersion?: string; maxVersion?: string }

export interface IscConfig {
  kind: string;
  apiVersion: string;
  mirror?: {
    platform?: { channels?: IscPlatformChannel[] };
    operators?: IscOperatorCatalog[];
  };
}

export function catalogKeyFromUrl(catalogUrl: string): string | null {
  if (!catalogUrl || catalogUrl.includes('@')) {
    return null;
  }
  const match = catalogUrl.match(/([^/:]+):([^/:]+)$/);
  if (!match) {
    return null;
  }
  return `${match[1]}:${match[2]}`;
}

export function buildReconcileCatalog(
  data: {
    operators: Record<
      string,
      Array<{
        name: string;
        defaultChannel?: string;
        channelVersions?: Record<string, string[]>;
      }>
    >;
  } | null,
): ReconcileCatalog {
  const catalog: ReconcileCatalog = new Map();
  if (!data?.operators) {
    return catalog;
  }
  for (const [key, operators] of Object.entries(data.operators)) {
    const byName = new Map<string, CatalogOperatorDetail>();
    for (const op of operators) {
      byName.set(op.name, {
        defaultChannel: op.defaultChannel ?? null,
        channelVersions: op.channelVersions ?? {},
      });
    }
    catalog.set(key, byName);
  }
  return catalog;
}

const minOf = (versions: string[]): string =>
  versions.reduce((a, b) => (compareVersionStrings(a, b) <= 0 ? a : b));

function suggestionId(
  kind: SuggestionKind,
  path: SuggestionPath,
): string {
  if (path.type === 'platform-channel') {
    return `${kind}|platform||${path.channel}`;
  }
  const channel = path.type === 'operator-channel' ? path.channel : '';
  return `${kind}|${path.catalog}|${path.package}|${channel}`;
}

export function reconcile(
  config: IscConfig,
  snapshot: DeployedOperatorSnapshot,
  catalog: ReconcileCatalog,
): ReconcileResult {
  const suggestions: Suggestion[] = [];
  const report: BehindReportEntry[] = [];
  const noData: NoDataEntry[] = [];
  const warnings: string[] = [];

  const badHubs = snapshot.hubs.filter(
    h => h.status !== 'ok' || h.truncated,
  );
  const trustworthy = snapshot.hubs.length > 0 && badHubs.length === 0;
  if (!trustworthy) {
    const causes = badHubs.length
      ? badHubs
          .map(
            h => `${h.name} (${h.status === 'error' ? 'error' : 'truncated'})`,
          )
          .join(', ')
      : 'no hubs in snapshot';
    warnings.push(
      `Channel-removal and unused-operator-reset suggestions are suppressed: ${causes}. ` +
        'A hub gap could hide the cluster still using a channel.',
    );
  }
  const fleetScope = `${snapshot.clusters.length} cluster(s) on ${snapshot.hubs.length} hub(s)`;

  for (const catEntry of config.mirror?.operators ?? []) {
    const key = catalogKeyFromUrl(catEntry.catalog ?? '');
    const catOps = key ? catalog.get(key) : undefined;
    if (!catOps) {
      warnings.push(
        `Catalog "${catEntry.catalog}" is not in the bundled catalog data — ` +
          'its packages cannot be reconciled against catalog channels.',
      );
    }

    for (const pkg of catEntry.packages ?? []) {
      const snapPkg = snapshot.packages[pkg.name];
      const detail = catOps?.get(pkg.name);
      const channels = pkg.channels ?? [];

      if (!detail) {
        noData.push({
          package: pkg.name,
          reason: catOps ? 'not-in-catalog' : 'catalog-unavailable',
        });
        if (!snapPkg) {
          continue;
        }
      }

      if (!snapPkg) {
        // Zero deployments fleet-wide (Task 5 adds the reset suggestion here).
        noData.push({ package: pkg.name, reason: 'no-fleet-data' });
        continue;
      }

      if (snapPkg.status === 'behind') {
        report.push({
          package: pkg.name,
          latestAvailable: snapPkg.latestAvailable,
          behindClusters: snapPkg.deployments
            .filter(d => d.behind)
            .map(d => ({
              cluster: d.cluster,
              hub: d.hub,
              version: d.version,
            })),
        });
      }

      if (!detail) {
        continue;
      }

      const versions = snapPkg.deployments.map(d => d.version);
      const inChannel = (version: string, channel: string): boolean =>
        (detail.channelVersions[channel] ?? []).includes(version);
      const unattributed = [
        ...new Set(
          versions.filter(
            v =>
              !Object.keys(detail.channelVersions).some(c => inChannel(v, c)),
          ),
        ),
      ];
      if (unattributed.length > 0) {
        warnings.push(
          `${pkg.name}: deployed version(s) ${unattributed.join(', ')} are in no ` +
            'catalog channel (skipRange-only upgrade graph?) — using numeric ' +
            'comparison for floors; channel removals are disabled for this package.',
        );
      }
      const removalsAllowed = trustworthy && unattributed.length === 0;
      const pkgFloor = minOf(versions);

      for (const ch of channels) {
        const chVersions = detail.channelVersions[ch.name];
        if (!chVersions) {
          warnings.push(
            `${pkg.name}: ISC channel "${ch.name}" is not in the catalog data — skipped.`,
          );
          continue;
        }
        const attributed = versions.filter(v => inChannel(v, ch.name));
        let floor: string | null = null;
        if (unattributed.length > 0) {
          floor = pkgFloor;
        } else if (attributed.length > 0) {
          floor = minOf(attributed);
        }
        const path: SuggestionPath = {
          type: 'operator-channel',
          catalog: catEntry.catalog,
          package: pkg.name,
          channel: ch.name,
        };
        if (floor === null) {
          if (removalsAllowed) {
            suggestions.push({
              id: suggestionId('remove-channel', path),
              kind: 'remove-channel',
              path,
              current: ch.minVersion?.trim() || null,
              proposed: null,
              evidence:
                `no deployed version of ${pkg.name} attributes to ` +
                `${ch.name} across ${fleetScope}. Removing only stops future ` +
                'mirroring; already-mirrored images are untouched.',
              defaultChecked: false,
            });
          }
          continue;
        }
        const current = ch.minVersion?.trim() || null;
        const pin = snapPkg.deployments.find(d => d.version === floor);
        const pinText = pin ? `${pin.cluster} @ ${pin.hub}` : 'unknown cluster';
        if (current === null || compareVersionStrings(floor, current) > 0) {
          suggestions.push({
            id: suggestionId('raise-min-version', path),
            kind: 'raise-min-version',
            path,
            current,
            proposed: floor,
            evidence: `floor pinned by ${pinText} (${floor})`,
            defaultChecked: true,
          });
        } else if (compareVersionStrings(floor, current) < 0) {
          suggestions.push({
            id: suggestionId('lower-min-version-drift', path),
            kind: 'lower-min-version-drift',
            path,
            current,
            proposed: floor,
            evidence:
              `DRIFT: ${pinText} runs ${floor}, below the current ` +
              `minVersion ${current} — the mirror no longer covers it`,
            defaultChecked: true,
          });
        }
      }
      // Task 5 adds add-channel scanning here.
    }
  }

  // Task 5 adds platform reconciliation here.

  return { suggestions, report, noData, warnings };
}
