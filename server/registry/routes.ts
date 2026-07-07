import express, { type Request, type Response, type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { catalogKeyFromUrl, type IscConfig } from '../acm/reconcile.js';
import {
  BundlesFileMissingError,
  BundlesSchemaError,
  loadBundlesFile,
} from '../bundlesLoader.js';
import { createRegistryClient } from './client.js';
import {
  buildOperatorContent,
  deriveExpectations,
  executeScan,
} from './scan.js';
import {
  RegistryStore,
  SCAN_SCHEMA_VERSION,
  ScanSnapshotSchemaError,
} from './store.js';
import type {
  CatalogBundles,
  MirrorRegistryConfig,
  RegistryScanSnapshot,
  ScanIssue,
} from './types.js';

export interface RegistryRouterDeps {
  storageDir: string;
  readPullSecretAuths: () => Promise<Record<
    string,
    { auth?: string }
  > | null>;
  resolveCatalogDir: () => Promise<string>;
  listIscConfigs: () => Promise<IscConfig[]>;
  createClient?: typeof createRegistryClient;
  now?: () => string;
}

interface RegistryInput {
  host?: unknown;
  pathPrefix?: unknown;
  insecureSkipVerify?: unknown;
  caBundle?: unknown;
}

export function normalizePathPrefix(input: unknown): string | null {
  if (input === undefined || input === null || input === '') {
    return '';
  }
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    return '';
  }
  if (!/^[a-z0-9]+([._/-][a-z0-9]+)*$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

type Handler = (req: Request, res: Response) => Promise<void>;

function wrap(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error(
        `Registry route error on ${req.method} ${req.path}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
      res.status(500).json({ error: 'internal server error' });
    }
  };
}

export function createRegistryRouter(deps: RegistryRouterDeps): Router {
  const store = new RegistryStore(deps.storageDir);
  const createClient = deps.createClient ?? createRegistryClient;
  const now = deps.now ?? (() => new Date().toISOString());
  const scansInFlight = new Set<string>();

  const router = express.Router();

  async function validateInput(
    input: RegistryInput,
    res: Response,
  ): Promise<{ host: string; pathPrefix: string } | null> {
    if (!input.host || typeof input.host !== 'string') {
      res.status(400).json({ error: 'host is required' });
      return null;
    }
    const pathPrefix = normalizePathPrefix(input.pathPrefix);
    if (pathPrefix === null) {
      res.status(400).json({
        error:
          'pathPrefix may only contain letters, digits, and . _ - / separators',
      });
      return null;
    }
    const auths = await deps.readPullSecretAuths();
    if (!auths?.[input.host]?.auth) {
      res.status(400).json({
        error: `no pull-secret credentials for "${input.host}" — add it to the pull secret first`,
      });
      return null;
    }
    return { host: input.host, pathPrefix };
  }

  router.get(
    '/',
    wrap(async (_req, res) => {
      const registries = await store.readRegistries();
      const auths = (await deps.readPullSecretAuths()) ?? {};
      res.json({
        registries: registries.map(r => ({
          ...r,
          insecureSkipVerify: Boolean(r.insecureSkipVerify),
          hasPullSecretAuth: Boolean(auths[r.host]?.auth),
        })),
      });
    }),
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      const input = (req.body ?? {}) as RegistryInput;
      const validated = await validateInput(input, res);
      if (!validated) {
        return;
      }
      const registries = await store.readRegistries();
      if (
        registries.some(
          r =>
            r.host === validated.host && r.pathPrefix === validated.pathPrefix,
        )
      ) {
        res.status(400).json({
          error: `"${validated.host}/${validated.pathPrefix}" is already configured`,
        });
        return;
      }
      const registry: MirrorRegistryConfig = {
        id: uuidv4(),
        host: validated.host,
        pathPrefix: validated.pathPrefix,
        insecureSkipVerify: Boolean(input.insecureSkipVerify),
        caBundle: (input.caBundle as string) || undefined,
      };
      registries.push(registry);
      await store.writeRegistries(registries);
      res.status(201).json({ registry });
    }),
  );

  router.put(
    '/:id',
    wrap(async (req, res) => {
      const registries = await store.readRegistries();
      const registry = registries.find(r => r.id === req.params.id);
      if (!registry) {
        res.status(404).json({ error: 'registry not found' });
        return;
      }
      const input = (req.body ?? {}) as RegistryInput;
      const validated = await validateInput(input, res);
      if (!validated) {
        return;
      }
      if (
        registries.some(
          r =>
            r.id !== req.params.id &&
            r.host === validated.host &&
            r.pathPrefix === validated.pathPrefix,
        )
      ) {
        res.status(400).json({
          error: `"${validated.host}/${validated.pathPrefix}" is already configured`,
        });
        return;
      }
      registry.host = validated.host;
      registry.pathPrefix = validated.pathPrefix;
      registry.insecureSkipVerify = Boolean(input.insecureSkipVerify);
      if (input.caBundle !== undefined) {
        // '' clears the stored bundle; omitted keeps it.
        registry.caBundle = (input.caBundle as string) || undefined;
      }
      await store.writeRegistries(registries);
      res.json({ registry });
    }),
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const registries = await store.readRegistries();
      const remaining = registries.filter(r => r.id !== req.params.id);
      if (remaining.length === registries.length) {
        res.status(404).json({ error: 'registry not found' });
        return;
      }
      await store.writeRegistries(remaining);
      await store.deleteScan(req.params.id);
      res.json({ deleted: req.params.id });
    }),
  );

  router.post(
    '/:id/scan',
    wrap(async (req, res) => {
      const registries = await store.readRegistries();
      const registry = registries.find(r => r.id === req.params.id);
      if (!registry) {
        res.status(404).json({ error: 'registry not found' });
        return;
      }
      if (scansInFlight.has(registry.id)) {
        res.status(409).json({ error: 'scan already in progress' });
        return;
      }
      scansInFlight.add(registry.id);
      try {
        const auths = await deps.readPullSecretAuths();
        const basicAuth = auths?.[registry.host]?.auth ?? null;
        if (!basicAuth) {
          res.status(400).json({
            error: `no pull-secret credentials for "${registry.host}" — add it to the pull secret first`,
          });
          return;
        }

        const iscs = await deps.listIscConfigs();
        const catalogKeys = new Set<string>();
        for (const isc of iscs) {
          for (const entry of isc.mirror?.operators ?? []) {
            const key = catalogKeyFromUrl(entry.catalog ?? '');
            if (key) {
              catalogKeys.add(key);
            }
          }
        }
        if (!catalogKeys.size) {
          res.status(400).json({
            error:
              'no managed ImageSetConfigurations reference an operator catalog — nothing to scan',
          });
          return;
        }

        const catalogDir = await deps.resolveCatalogDir();
        const catalogBundles: CatalogBundles[] = [];
        const catalogIssues: ScanIssue[] = [];
        for (const key of [...catalogKeys].sort()) {
          const sep = key.lastIndexOf(':');
          const catalogType = key.slice(0, sep);
          const version = key.slice(sep + 1);
          try {
            catalogBundles.push({
              catalog: key,
              bundles: await loadBundlesFile(catalogDir, catalogType, version),
            });
          } catch (error) {
            if (
              error instanceof BundlesFileMissingError ||
              error instanceof BundlesSchemaError
            ) {
              catalogIssues.push({
                repo: null,
                catalog: key,
                kind: 'catalog-data',
                message: error.message,
              });
            } else {
              throw error;
            }
          }
        }

        const expectations = deriveExpectations(
          catalogBundles,
          registry.pathPrefix,
        );
        if (!expectations.size) {
          res.status(400).json({
            error:
              'no bundle repos could be derived from the referenced catalogs — regenerate catalog data (bundles.json missing?)',
            issues: catalogIssues,
          });
          return;
        }

        const client = createClient({
          host: registry.host,
          basicAuth,
          caBundle: registry.caBundle,
          insecureSkipVerify: registry.insecureSkipVerify,
        });
        const result = await executeScan(expectations, client);
        const errors = [...catalogIssues, ...result.errors];
        const snapshot: RegistryScanSnapshot = {
          schemaVersion: SCAN_SCHEMA_VERSION,
          registryId: registry.id,
          host: registry.host,
          pathPrefix: registry.pathPrefix,
          scannedAt: now(),
          partial: errors.length > 0,
          catalogs: catalogBundles.map(c => c.catalog),
          repos: result.repos,
          errors,
          stats: result.stats,
        };
        await store.writeScan(snapshot);
        res.json(snapshot);
      } finally {
        scansInFlight.delete(registry.id);
      }
    }),
  );

  router.get(
    '/:id/operator-content',
    wrap(async (req, res) => {
      const registries = await store.readRegistries();
      const registry = registries.find(r => r.id === req.params.id);
      if (!registry) {
        res.status(404).json({ error: 'registry not found' });
        return;
      }
      let snapshot: RegistryScanSnapshot | null;
      try {
        snapshot = await store.readScan(registry.id);
      } catch (error) {
        if (error instanceof ScanSnapshotSchemaError) {
          res.status(422).json({
            error:
              'stored scan was written by an incompatible version — scan again to rebuild it',
          });
          return;
        }
        throw error;
      }
      if (!snapshot) {
        res.status(404).json({ error: 'never scanned' });
        return;
      }
      res.json(buildOperatorContent(snapshot));
    }),
  );

  return router;
}
