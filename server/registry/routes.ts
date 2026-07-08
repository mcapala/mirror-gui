import express, { type Request, type Response, type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { catalogKeyFromUrl, type IscConfig } from '../acm/reconcile.js';
import type { DeployedOperatorSnapshot } from '../acm/types.js';
import {
  BundlesFileMissingError,
  BundlesSchemaError,
  loadBundlesFile,
} from '../bundlesLoader.js';
import { createRegistryClient } from './client.js';
import { resolveRegistryCredentials } from './credentials.js';
import { generateDisc, type OrphanPick } from './disc.js';
import {
  buildOperatorContent,
  buildScanTargets,
  deriveAdditionalExpectations,
  deriveExpectations,
  derivePlatformRepos,
  deriveSupportRepos,
  executeScan,
} from './scan.js';
import {
  RegistryStore,
  SCAN_SCHEMA_VERSION,
  ScanSnapshotSchemaError,
} from './store.js';
import { RegistryRequestError } from './types.js';
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
  readAcmSnapshot: () => Promise<DeployedOperatorSnapshot | null>;
  createClient?: typeof createRegistryClient;
  now?: () => string;
}

interface RegistryInput {
  host?: unknown;
  pathPrefix?: unknown;
  insecureSkipVerify?: unknown;
  caBundle?: unknown;
  username?: unknown;
  password?: unknown;
}

type PullSecretAuths = Record<string, { auth?: string }>;

function redactRegistry(r: MirrorRegistryConfig, auths: PullSecretAuths) {
  const rest: Partial<MirrorRegistryConfig> = { ...r };
  delete rest.password;
  return {
    ...rest,
    insecureSkipVerify: Boolean(r.insecureSkipVerify),
    hasCredentials: Boolean(r.username && r.password),
    hasPullSecretAuth: Boolean(auths[r.host]?.auth),
  };
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

async function loadCatalogBundles(
  catalogDir: string,
  keys: string[],
): Promise<{ catalogBundles: CatalogBundles[]; catalogIssues: ScanIssue[] }> {
  const catalogBundles: CatalogBundles[] = [];
  const catalogIssues: ScanIssue[] = [];
  for (const key of [...keys].sort()) {
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
  return { catalogBundles, catalogIssues };
}

export function createRegistryRouter(deps: RegistryRouterDeps): Router {
  const store = new RegistryStore(deps.storageDir);
  const createClient = deps.createClient ?? createRegistryClient;
  const now = deps.now ?? (() => new Date().toISOString());
  const scansInFlight = new Set<string>();

  const router = express.Router();

  function validateInput(
    input: RegistryInput,
    res: Response,
  ): { host: string; pathPrefix: string } | null {
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
    if (input.username !== undefined && typeof input.username !== 'string') {
      res.status(400).json({ error: 'username must be a string' });
      return null;
    }
    if (input.password !== undefined && typeof input.password !== 'string') {
      res.status(400).json({ error: 'password must be a string' });
      return null;
    }
    return { host: input.host, pathPrefix };
  }

  router.get(
    '/',
    wrap(async (_req, res) => {
      const registries = await store.readRegistries();
      const auths = (await deps.readPullSecretAuths()) ?? {};
      res.json({ registries: registries.map(r => redactRegistry(r, auths)) });
    }),
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      const input = (req.body ?? {}) as RegistryInput;
      const validated = validateInput(input, res);
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
      const username = typeof input.username === 'string' ? input.username : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if ((username === '') !== (password === '')) {
        res
          .status(400)
          .json({ error: 'username and password must be provided together' });
        return;
      }
      const registry: MirrorRegistryConfig = {
        id: uuidv4(),
        host: validated.host,
        pathPrefix: validated.pathPrefix,
        insecureSkipVerify: Boolean(input.insecureSkipVerify),
        caBundle: (input.caBundle as string) || undefined,
        ...(username ? { username, password } : {}),
      };
      registries.push(registry);
      await store.writeRegistries(registries);
      const auths = (await deps.readPullSecretAuths()) ?? {};
      res.status(201).json({ registry: redactRegistry(registry, auths) });
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
      const validated = validateInput(input, res);
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
      const username = typeof input.username === 'string' ? input.username : '';
      if (!username && typeof input.password === 'string' && input.password) {
        res
          .status(400)
          .json({ error: 'username and password must be provided together' });
        return;
      }
      if (!username || input.password === '') {
        delete registry.username;
        delete registry.password;
      } else if (typeof input.password === 'string') {
        registry.username = username;
        registry.password = input.password;
      } else {
        if (!registry.password) {
          res.status(400).json({
            error: 'password is required when setting credentials',
          });
          return;
        }
        registry.username = username;
      }
      await store.writeRegistries(registries);
      const auths = (await deps.readPullSecretAuths()) ?? {};
      res.json({ registry: redactRegistry(registry, auths) });
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
    '/:id/verify',
    wrap(async (req, res) => {
      const registries = await store.readRegistries();
      const registry = registries.find(r => r.id === req.params.id);
      if (!registry) {
        res.status(404).json({ error: 'registry not found' });
        return;
      }
      const auths = await deps.readPullSecretAuths();
      const { basicAuth, source } = resolveRegistryCredentials(
        registry,
        auths,
      );
      const client = createClient({
        host: registry.host,
        basicAuth,
        caBundle: registry.caBundle,
        insecureSkipVerify: registry.insecureSkipVerify,
      });
      try {
        await client.ping();
        res.json({ ok: true, source });
      } catch (error) {
        if (error instanceof RegistryRequestError) {
          res.json({ ok: false, source, kind: error.kind, error: error.message });
          return;
        }
        throw error;
      }
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
        const { basicAuth } = resolveRegistryCredentials(registry, auths);

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
        const { catalogBundles, catalogIssues } = await loadCatalogBundles(
          catalogDir,
          Array.from(catalogKeys),
        );

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
        const additionalExpectations = deriveAdditionalExpectations(
          iscs,
          registry.pathPrefix,
        );
        const supportRepos = deriveSupportRepos(
          catalogBundles,
          iscs,
          registry.pathPrefix,
        );
        const platformRepos = derivePlatformRepos(iscs, registry.pathPrefix);

        const client = createClient({
          host: registry.host,
          basicAuth,
          caBundle: registry.caBundle,
          insecureSkipVerify: registry.insecureSkipVerify,
        });

        // Probe /v2/ first so a credential problem fails the whole scan
        // loudly; executeScan then safely treats per-repo 401s as "repo
        // absent" (registries hide unknown repos behind 401).
        try {
          await client.ping();
        } catch (error) {
          if (error instanceof RegistryRequestError) {
            res.status(502).json({
              error: `registry probe failed: ${error.message}`,
              kind: error.kind,
            });
            return;
          }
          throw error;
        }

        let walkedRepos: string[] = [];
        let walkOk = true;
        const walkIssues: ScanIssue[] = [];
        try {
          const listed = await client.listRepositories();
          if (listed === null) {
            // _catalog answered 404 — the registry doesn't implement it.
            // A registry property, not a scan failure: walkOk carries the
            // signal, no error entry (would flag every scan "partial").
            walkOk = false;
          } else {
            const prefix = registry.pathPrefix
              ? `${registry.pathPrefix}/`
              : '';
            walkedRepos = prefix
              ? listed.filter(r => r.startsWith(prefix))
              : listed;
          }
        } catch (error) {
          walkOk = false;
          // ping() already proved the credentials against /v2/, so an
          // auth-kind failure here means the registry refuses to grant the
          // catalog scope (e.g. token server 400s registry:catalog:*) —
          // same class as a 404: walk unsupported, not a scan error.
          if (
            !(error instanceof RegistryRequestError) ||
            error.kind !== 'auth'
          ) {
            walkIssues.push(
              error instanceof RegistryRequestError
                ? {
                    repo: null,
                    catalog: null,
                    kind: error.kind,
                    message: `_catalog walk failed: ${error.message}`,
                  }
                : {
                    repo: null,
                    catalog: null,
                    kind: 'unreachable',
                    message: `_catalog walk failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  },
            );
          }
        }

        const targets = buildScanTargets(
          expectations,
          additionalExpectations,
          walkedRepos,
          supportRepos,
          platformRepos,
        );
        const result = await executeScan(targets, client, {
          knownRepos: walkOk ? new Set(walkedRepos) : undefined,
        });
        const errors = [...catalogIssues, ...walkIssues, ...result.errors];
        const snapshot: RegistryScanSnapshot = {
          schemaVersion: SCAN_SCHEMA_VERSION,
          registryId: registry.id,
          host: registry.host,
          pathPrefix: registry.pathPrefix,
          scannedAt: now(),
          partial: errors.length > 0,
          walkOk,
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

  router.post(
    '/:id/generate-disc',
    wrap(async (req, res) => {
      const registries = await store.readRegistries();
      const registry = registries.find(r => r.id === req.params.id);
      if (!registry) {
        res.status(404).json({ error: 'registry not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        strict?: unknown;
        includeAdditionalImages?: unknown;
        includeOrphans?: unknown;
      };
      if (body.strict !== undefined && typeof body.strict !== 'boolean') {
        res.status(400).json({ error: 'strict must be a boolean' });
        return;
      }
      if (
        body.includeAdditionalImages !== undefined &&
        typeof body.includeAdditionalImages !== 'boolean'
      ) {
        res.status(400).json({ error: 'includeAdditionalImages must be a boolean' });
        return;
      }
      const rawPicks = body.includeOrphans ?? [];
      if (
        !Array.isArray(rawPicks) ||
        rawPicks.some(
          p =>
            typeof p?.repo !== 'string' ||
            typeof p?.tag !== 'string' ||
            typeof p?.sourceRef !== 'string',
        )
      ) {
        res.status(400).json({
          error:
            'includeOrphans must be an array of { repo, tag, sourceRef } strings',
        });
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
      const catalogDir = await deps.resolveCatalogDir();
      const { catalogBundles } = await loadCatalogBundles(
        catalogDir,
        snapshot.catalogs,
      );
      const acm = await deps.readAcmSnapshot();
      const iscs = await deps.listIscConfigs();
      const result = generateDisc(
        { snapshot, catalogs: catalogBundles, acm, iscs },
        {
          strict: body.strict === true,
          includeAdditionalImages: body.includeAdditionalImages !== false,
          includeOrphans: rawPicks as OrphanPick[],
        },
      );
      if (result.strictViolation) {
        res.status(422).json({
          error:
            'strict mode: candidates were held back by the fleet gate — see report',
          report: result.report,
        });
        return;
      }
      res.json({ discYaml: result.discYaml, report: result.report });
    }),
  );

  return router;
}
