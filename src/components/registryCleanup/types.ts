export interface MirrorRegistry {
  id: string;
  host: string;
  pathPrefix: string;
}

export interface OperatorCandidate {
  catalog: string;
  catalogRef: string;
  package: string;
  channel: string;
  version: string;
  bundleName: string;
  repo: string;
  tag: string;
  digest: string | null;
}

export interface HeldCandidate {
  kind: 'operator' | 'additional-image';
  reason: 'still-deployed' | 'shared-image' | 'acm-unverifiable';
  detail: string;
  package?: string;
  version?: string;
  bundleName?: string;
  repo?: string;
  tag?: string;
}

export interface AdditionalCandidate {
  repo: string;
  tag: string;
  digest: string | null;
  sourceRef: string;
}

export interface OrphanItem {
  repo: string;
  tag: string;
  digest: string | null;
  suggestedRef: string;
  hostAmbiguous: boolean;
}

export interface DiscReport {
  registryId: string;
  host: string;
  pathPrefix: string;
  scannedAt: string;
  acmRefreshedAt: string | null;
  walkOk: boolean;
  warnings: string[];
  operators: {
    candidates: OperatorCandidate[];
    held: HeldCandidate[];
    unknownTags: Array<{ repo: string; tag: string; digest: string | null }>;
    unverifiableRepos: Array<{ repo: string; message: string }>;
    channelUnpinned: Array<{ catalog: string; package: string }>;
    unknownChannels: Array<{ catalog: string; package: string; channel: string }>;
    manualBundles: Array<{
      catalog: string;
      package: string;
      bundleName: string;
      version: string | null;
      repo: string;
      tag: string;
      reason: string;
    }>;
  };
  additionalImages: {
    class1: AdditionalCandidate[];
    held: HeldCandidate[];
    orphans: OrphanItem[];
    rejectedPicks: Array<{ repo: string; tag: string; reason: string }>;
  };
  stats: { discOperatorEntries: number; discAdditionalImages: number };
}

export interface GenerateResponse {
  discYaml: string;
  report: DiscReport;
}
