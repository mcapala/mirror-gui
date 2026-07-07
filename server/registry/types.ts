import type { BundlesFile } from '../bundlesLoader.js';

export interface MirrorRegistryConfig {
  id: string;
  /** Exact pull-secret auths key; may include a port. */
  host: string;
  /** '' = registry root; multi-segment allowed; no leading/trailing slashes. */
  pathPrefix: string;
  insecureSkipVerify?: boolean;
  caBundle?: string;
}

export type ScanErrorKind =
  | 'auth'
  | 'tls'
  | 'unreachable'
  | 'bad-response'
  | 'catalog-data';

export class RegistryRequestError extends Error {
  kind: ScanErrorKind;

  constructor(kind: ScanErrorKind, message: string) {
    super(message);
    this.name = 'RegistryRequestError';
    this.kind = kind;
  }
}

export interface ExpectedBundleRef {
  package: string;
  bundleName: string;
  version: string | null;
  /** Catalog key, e.g. "redhat-operator-index:v4.21". */
  catalog: string;
}

export interface RepoExpectation {
  repo: string;
  byDigest: Map<string, ExpectedBundleRef>;
  byTag: Map<string, ExpectedBundleRef>;
}

export type RepoOrigin = 'operator' | 'additional' | 'walk';

export interface ScannedTag {
  tag: string;
  digest: string | null;
  matched: ExpectedBundleRef | null;
  /** Source ref of the additionalImage this tag satisfies, else null. */
  matchedAdditional: string | null;
}

export interface ScannedRepo {
  repo: string;
  present: boolean;
  origin: RepoOrigin;
  /** Unique source registry host for origin 'additional'; null otherwise or
   * when more than one host maps here. */
  sourceHost: string | null;
  /** True when >1 source host maps onto this repo path (spec §3.2). */
  hostAmbiguous: boolean;
  tags: ScannedTag[];
}

export interface ScanIssue {
  repo: string | null;
  catalog: string | null;
  kind: ScanErrorKind;
  message: string;
}

export interface ScanStats {
  reposExpected: number;
  reposPresent: number;
  tagsScanned: number;
  matched: number;
  unknown: number;
  reposAdditional: number;
  reposWalked: number;
}

export interface RegistryScanSnapshot {
  schemaVersion: 2;
  registryId: string;
  host: string;
  pathPrefix: string;
  scannedAt: string;
  partial: boolean;
  /** True when the /v2/_catalog walk completed; false → orphan list incomplete. */
  walkOk: boolean;
  catalogs: string[];
  repos: ScannedRepo[];
  errors: ScanIssue[];
  stats: ScanStats;
}

/** Expected additionalImages content of one repo (map values = source refs). */
export interface AdditionalRepoExpectation {
  repo: string;
  sourceHosts: Set<string>;
  byDigest: Map<string, string>;
  byTag: Map<string, string>;
}

export interface OperatorContentVersion {
  version: string | null;
  bundleName: string;
  repo: string;
  tag: string;
  digest: string | null;
  catalog: string;
}

export interface OperatorContentReport {
  registryId: string;
  host: string;
  pathPrefix: string;
  scannedAt: string;
  partial: boolean;
  catalogs: string[];
  packages: Record<string, OperatorContentVersion[]>;
  unknownTags: Array<{ repo: string; tag: string; digest: string | null }>;
  errors: ScanIssue[];
  stats: ScanStats;
}

export interface CatalogBundles {
  /** Catalog key, e.g. "redhat-operator-index:v4.21". */
  catalog: string;
  bundles: BundlesFile;
}
