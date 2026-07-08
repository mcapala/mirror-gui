export interface AcmHub {
  id: string;
  name: string;
  url: string;
  token: string;
  caBundle?: string;
  insecureSkipVerify?: boolean;
  /** Managed clusters included in fleet queries. Empty/absent = hub inactive. */
  clusters?: string[];
}

export interface RedactedAcmHub {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  hasCaBundle: boolean;
  insecureSkipVerify: boolean;
  clusters: string[];
}

export function redactHub(hub: AcmHub): RedactedAcmHub {
  return {
    id: hub.id,
    name: hub.name,
    url: hub.url,
    hasToken: Boolean(hub.token),
    hasCaBundle: Boolean(hub.caBundle),
    insecureSkipVerify: Boolean(hub.insecureSkipVerify),
    clusters: hub.clusters ?? [],
  };
}

export interface CsvSearchItem {
  name: string;
  cluster: string;
  phase: string;
}

export interface ClusterSearchItem {
  name?: string;
  openshiftVersion?: string;
  version?: string;
  label?: string;
}

export interface HubQueryResult {
  csvItems: CsvSearchItem[];
  clusterItems: ClusterSearchItem[];
  truncated: boolean;
}

export interface ClusterInfo {
  cluster: string;
  hub: string;
  openshiftVersion: string;
}

export type HubErrorKind = 'auth' | 'tls' | 'unreachable' | 'bad-response';

export class HubQueryError extends Error {
  kind: HubErrorKind;

  constructor(kind: HubErrorKind, message: string) {
    super(message);
    this.name = 'HubQueryError';
    this.kind = kind;
  }
}

export interface HubSnapshotStatus {
  id: string;
  name: string;
  status: 'ok' | 'error';
  error: string | null;
  truncated: boolean;
  skippedItems: number;
  clusterCount: number;
  /** True when the hub was skipped because it has no cluster selection. */
  unconfigured?: boolean;
}

export interface PackageDeployment {
  cluster: string;
  hub: string;
  version: string;
  behind: boolean;
}

export type PackageStatus = 'current' | 'behind' | 'unknown';

export interface PackageSnapshot {
  deployments: PackageDeployment[];
  minDeployed: string;
  maxDeployed: string;
  latestAvailable: string | null;
  catalogSource: string | null;
  status: PackageStatus;
  /** CSV-name prefixes that contributed deployments via the alias map (M3). */
  csvNamePrefixes?: string[];
}

export interface DeployedOperatorSnapshot {
  schemaVersion: 2;
  refreshedAt: string;
  hubs: HubSnapshotStatus[];
  clusters: ClusterInfo[];
  packages: Record<string, PackageSnapshot>;
}

export interface CatalogPackageInfo {
  latestAvailable: string;
  catalogSource: string;
}

export type CatalogLookup = Map<string, CatalogPackageInfo>;

// csvNamePrefix -> canonical OLM package name (from operators.json csvNamePrefixes)
export type AliasLookup = Map<string, string>;
