export interface MirrorRegistry {
  id: string;
  host: string;
  pathPrefix: string;
  insecureSkipVerify: boolean;
  caBundle?: string;
  username?: string;
  hasCredentials: boolean;
  hasPullSecretAuth: boolean;
}

export interface OperatorContentVersion {
  version: string | null;
  bundleName: string;
  repo: string;
  tag: string;
  digest: string | null;
  catalog: string;
}

export interface ScanIssue {
  repo: string | null;
  catalog: string | null;
  kind: string;
  message: string;
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
  walkOk: boolean;
  additionalImages: Array<{
    repo: string;
    tag: string;
    digest: string | null;
    source: string | null;
  }>;
  errors: ScanIssue[];
  stats: {
    reposExpected: number;
    reposPresent: number;
    tagsScanned: number;
    matched: number;
    unknown: number;
  };
}
