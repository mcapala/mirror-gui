import type { ImageSetConfig } from './MirrorConfig';

export interface DetailedOperator {
  name: string;
  defaultChannel: string;
  allChannels: string[];
}

export interface CleanChannel {
  name: string;
  type?: string;
  minVersion?: string;
  maxVersion?: string;
  shortestPath?: boolean;
}

export interface CleanOperatorChannel {
  name: string;
  minVersion?: string;
  maxVersion?: string;
}

export interface CleanConfig {
  kind: string;
  apiVersion: string;
  archiveSize?: number;
  mirror: {
    platform?: Record<string, unknown>;
    operators?: {
      catalog: string;
      packages: {
        name: string;
        defaultChannel?: string;
        channels: CleanOperatorChannel[];
      }[];
    }[];
    additionalImages?: { name: string }[];
  };
}

export const getArchiveSizeValidationMessage = (value: string): string => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return '';
  }

  if (!/^\d+$/.test(trimmedValue)) {
    return 'Archive size must contain digits only';
  }

  if (Number.parseInt(trimmedValue, 10) <= 0) {
    return 'Archive size must be greater than 0';
  }

  return '';
};

export interface CleanConfigOptions {
  useDigestRef?: boolean;
  catalogDigestMap?: Record<string, string>;
  detailedOperators?: Record<string, DetailedOperator[]>;
}

export function buildCleanConfig(
  config: ImageSetConfig,
  opts: CleanConfigOptions = {},
): CleanConfig {
  const {
    useDigestRef = false,
    catalogDigestMap = {},
    detailedOperators = {},
  } = opts;
  const clean: CleanConfig = {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    mirror: {},
  };

  const archiveSizeValue = config.archiveSize.trim();
  if (archiveSizeValue && !getArchiveSizeValidationMessage(archiveSizeValue)) {
    clean.archiveSize = Number.parseInt(archiveSizeValue, 10);
  }

  if (config.mirror.platform.channels?.length > 0) {
    const platformConfig: Record<string, unknown> = {
      channels: config.mirror.platform.channels.map(ch => {
        const c: CleanChannel = { name: ch.name, type: ch.type };
        if (ch.minVersion?.trim()) c.minVersion = ch.minVersion;
        if (ch.maxVersion?.trim()) c.maxVersion = ch.maxVersion;
        if (ch.shortestPath === true) c.shortestPath = true;
        return c;
      }),
    };
    if (config.mirror.platform.graph === true) {
      platformConfig.graph = true;
    }
    clean.mirror.platform = platformConfig;
  }

  if (config.mirror.operators?.length > 0) {
    clean.mirror.operators = config.mirror.operators.map(operator => {
      const catalogRef = operator.catalog;
      const resolvedCatalog = useDigestRef && catalogDigestMap[catalogRef]
        ? catalogRef.replace(/:v[\d.]+$/, `@${catalogDigestMap[catalogRef]}`)
        : catalogRef;
      return {
      catalog: resolvedCatalog,
      packages: operator.packages.map(pkg => {
        const operatorInfo = detailedOperators[operator.catalog]
          ?.find(op => op.name === pkg.name);
        const selectedChannelNames = pkg.channels.map(ch => ch.name);
        const originalDefault = operatorInfo?.defaultChannel;
        const needsDefaultOverride = originalDefault
          && !selectedChannelNames.includes(originalDefault);

        const cleanPkg: { name: string; defaultChannel?: string; channels: CleanOperatorChannel[] } = {
          name: pkg.name,
          channels: pkg.channels.map(ch => {
            const c: CleanOperatorChannel = { name: ch.name };
            if (ch.minVersion?.trim()) c.minVersion = ch.minVersion;
            return c;
          }),
        };

        if (needsDefaultOverride && selectedChannelNames.length > 0) {
          cleanPkg.defaultChannel = selectedChannelNames[0];
        }

        return cleanPkg;
      }),
    };
    });
  }

  if (config.mirror.additionalImages?.length > 0) {
    clean.mirror.additionalImages = config.mirror.additionalImages;
  }

  return clean;
}
