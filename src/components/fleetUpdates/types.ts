export type SuggestionKind =
  | 'raise-min-version'
  | 'lower-min-version-drift'
  | 'raise-platform-min-version'
  | 'add-channel'
  | 'add-operator'
  | 'remove-channel'
  | 'reset-unused-operator'
  | 'bump-catalog';

export type SuggestionPath =
  | {
      type: 'operator-channel';
      catalog: string;
      package: string;
      channel: string;
    }
  | { type: 'operator'; catalog: string; package: string }
  | { type: 'platform-channel'; channel: string }
  | { type: 'catalog'; catalog: string };

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  path: SuggestionPath;
  current: string | null;
  proposed: string | null;
  proposedChannels?: { name: string; minVersion: string }[];
  proposedCatalog?: string;
  movedPackages?: string[];
  channelRewrites?: Record<string, { name: string; minVersion: string }[]>;
  evidence: string;
  notes?: string[];
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

export interface SnapshotHubStatus {
  id: string;
  name: string;
  status: 'ok' | 'error';
  error: string | null;
  truncated: boolean;
  clusterCount: number;
}

export interface SnapshotMeta {
  refreshedAt: string;
  hubs: SnapshotHubStatus[];
}
