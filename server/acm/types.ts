export interface AcmHub {
  id: string;
  name: string;
  url: string;
  token: string;
  caBundle?: string;
  insecureSkipVerify?: boolean;
}

export interface RedactedAcmHub {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  hasCaBundle: boolean;
  insecureSkipVerify: boolean;
}

export function redactHub(hub: AcmHub): RedactedAcmHub {
  return {
    id: hub.id,
    name: hub.name,
    url: hub.url,
    hasToken: Boolean(hub.token),
    hasCaBundle: Boolean(hub.caBundle),
    insecureSkipVerify: Boolean(hub.insecureSkipVerify),
  };
}

export interface CsvSearchItem {
  name: string;
  cluster: string;
  phase: string;
}

export interface HubQueryResult {
  items: CsvSearchItem[];
  truncated: boolean;
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
}

export interface DeployedOperatorSnapshot {
  schemaVersion: 1;
  refreshedAt: string;
  hubs: HubSnapshotStatus[];
  packages: Record<string, PackageSnapshot>;
}

export interface CatalogPackageInfo {
  latestAvailable: string;
  catalogSource: string;
}

export type CatalogLookup = Map<string, CatalogPackageInfo>;
