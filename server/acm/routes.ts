import express, { type Request, type Response, type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AcmStore, SnapshotSchemaError } from './snapshotStore.js';
import {
  buildAliasLookup,
  buildCatalogLookup,
  buildSnapshot,
  type CatalogDataLike,
  type HubFetchOutcome,
} from './aggregate.js';
import { queryHub as defaultQueryHub } from './client.js';
import { buildReconcileCatalog, reconcile, type IscConfig } from './reconcile.js';
import { HubQueryError, redactHub, type AcmHub } from './types.js';

export interface AcmRouterDeps {
  acmDir: string;
  loadCatalogData: () => Promise<CatalogDataLike | null>;
  queryHub?: typeof defaultQueryHub;
  now?: () => string;
}

interface HubInput {
  name?: unknown;
  url?: unknown;
  token?: unknown;
  caBundle?: unknown;
  insecureSkipVerify?: unknown;
  clusters?: unknown;
}

function validateHubInput(
  input: HubInput,
  { requireToken }: { requireToken: boolean },
): string | null {
  if (!input.name || typeof input.name !== 'string') {
    return 'name is required';
  }
  if (
    !input.url ||
    typeof input.url !== 'string' ||
    !input.url.startsWith('https://')
  ) {
    return 'url is required and must start with https://';
  }
  if (requireToken && (!input.token || typeof input.token !== 'string')) {
    return 'token is required';
  }
  return null;
}

type ClustersParse =
  | { ok: true; clusters: string[] | undefined }
  | { ok: false; error: string };

function parseClustersInput(value: unknown): ClustersParse {
  if (value === undefined) {
    return { ok: true, clusters: undefined };
  }
  if (
    !Array.isArray(value) ||
    value.some(entry => typeof entry !== 'string' || !entry)
  ) {
    return { ok: false, error: 'clusters must be an array of cluster names' };
  }
  return { ok: true, clusters: [...new Set(value as string[])].sort() };
}

type Handler = (req: Request, res: Response) => Promise<void>;

function wrap(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error(
        `ACM route error on ${req.method} ${req.path}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
      res.status(500).json({ error: 'internal server error' });
    }
  };
}

export function createAcmRouter(deps: AcmRouterDeps): Router {
  const store = new AcmStore(deps.acmDir);
  const queryHub = deps.queryHub ?? defaultQueryHub;
  const now = deps.now ?? (() => new Date().toISOString());
  let refreshInFlight = false;

  const router = express.Router();

  router.get(
    '/hubs',
    wrap(async (_req, res) => {
      const hubs = await store.readHubs();
      res.json({ hubs: hubs.map(redactHub) });
    }),
  );

  router.post(
    '/hubs',
    wrap(async (req, res) => {
      const input = (req.body ?? {}) as HubInput;
      const error = validateHubInput(input, { requireToken: true });
      if (error) {
        res.status(400).json({ error });
        return;
      }
      const clustersParse = parseClustersInput(input.clusters);
      if (!clustersParse.ok) {
        res.status(400).json({ error: clustersParse.error });
        return;
      }
      const hubs = await store.readHubs();
      if (hubs.some(h => h.name === (input.name as string))) {
        res
          .status(400)
          .json({ error: `a hub named "${input.name as string}" already exists` });
        return;
      }
      const hub: AcmHub = {
        id: uuidv4(),
        name: input.name as string,
        url: (input.url as string).replace(/\/+$/, ''),
        token: input.token as string,
        caBundle: (input.caBundle as string) || undefined,
        insecureSkipVerify: Boolean(input.insecureSkipVerify),
        clusters: clustersParse.clusters ?? [],
      };
      hubs.push(hub);
      await store.writeHubs(hubs);
      res.status(201).json({ hub: redactHub(hub) });
    }),
  );

  router.put(
    '/hubs/:id',
    wrap(async (req, res) => {
      const hubs = await store.readHubs();
      const hub = hubs.find(h => h.id === req.params.id);
      if (!hub) {
        res.status(404).json({ error: 'hub not found' });
        return;
      }
      const input = (req.body ?? {}) as HubInput;
      const error = validateHubInput(input, { requireToken: false });
      if (error) {
        res.status(400).json({ error });
        return;
      }
      const clustersParse = parseClustersInput(input.clusters);
      if (!clustersParse.ok) {
        res.status(400).json({ error: clustersParse.error });
        return;
      }
      if (
        hubs.some(
          h => h.id !== req.params.id && h.name === (input.name as string),
        )
      ) {
        res
          .status(400)
          .json({ error: `a hub named "${input.name as string}" already exists` });
        return;
      }
      hub.name = input.name as string;
      hub.url = (input.url as string).replace(/\/+$/, '');
      if (input.token && typeof input.token === 'string') {
        hub.token = input.token;
      }
      if (input.caBundle !== undefined) {
        // '' clears the stored bundle; omitted keeps it.
        hub.caBundle = (input.caBundle as string) || undefined;
      }
      hub.insecureSkipVerify = Boolean(input.insecureSkipVerify);
      if (clustersParse.clusters !== undefined) {
        // present replaces (empty array clears); omitted keeps
        hub.clusters = clustersParse.clusters;
      }
      await store.writeHubs(hubs);
      res.json({ hub: redactHub(hub) });
    }),
  );

  router.delete(
    '/hubs/:id',
    wrap(async (req, res) => {
      const hubs = await store.readHubs();
      const remaining = hubs.filter(h => h.id !== req.params.id);
      if (remaining.length === hubs.length) {
        res.status(404).json({ error: 'hub not found' });
        return;
      }
      await store.writeHubs(remaining);
      res.json({ deleted: req.params.id });
    }),
  );

  router.post(
    '/hubs/:id/test',
    wrap(async (req, res) => {
      const hubs = await store.readHubs();
      const hub = hubs.find(h => h.id === req.params.id);
      if (!hub) {
        res.status(404).json({ error: 'hub not found' });
        return;
      }
      try {
        await queryHub(hub, { limit: 1 });
        res.json({ status: 'ok' });
      } catch (error) {
        const kind = error instanceof HubQueryError ? error.kind : 'unreachable';
        const message =
          error instanceof Error ? error.message : String(error);
        res.json({ status: 'failed', kind, error: message });
      }
    }),
  );

  router.post(
    '/refresh',
    wrap(async (_req, res) => {
      if (refreshInFlight) {
        res.status(409).json({ error: 'refresh already in progress' });
        return;
      }
      refreshInFlight = true;
      try {
        const hubs = await store.readHubs();
        if (!hubs.length) {
          res.status(400).json({ error: 'no ACM hubs configured' });
          return;
        }
        const settled = await Promise.allSettled(hubs.map(h => queryHub(h)));
        const outcomes: HubFetchOutcome[] = settled.map((result, i) =>
          result.status === 'fulfilled'
            ? {
                hub: hubs[i],
                status: 'ok',
                items: result.value.csvItems,
                clusterItems: result.value.clusterItems,
                truncated: result.value.truncated,
              }
            : {
                hub: hubs[i],
                status: 'error',
                error:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              },
        );
        const catalogData = await deps.loadCatalogData().catch((error: unknown) => {
          console.warn(
            `ACM refresh: catalog data load failed, statuses will be 'unknown': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        });
        const catalog = buildCatalogLookup(catalogData);
        const aliases = buildAliasLookup(catalogData);
        const snapshot = buildSnapshot(outcomes, catalog, now(), aliases);
        await store.writeSnapshot(snapshot);
        res.json(snapshot);
      } finally {
        refreshInFlight = false;
      }
    }),
  );

  type SnapshotOutcome =
    | { ok: true; snapshot: Awaited<ReturnType<AcmStore['readSnapshot']>> }
    | { ok: false };

  async function readSnapshotOr422(res: Response): Promise<SnapshotOutcome> {
    try {
      return { ok: true, snapshot: await store.readSnapshot() };
    } catch (error) {
      if (error instanceof SnapshotSchemaError) {
        res.status(422).json({
          error:
            'stored snapshot was written by an incompatible version — refresh to rebuild it',
        });
        return { ok: false };
      }
      throw error;
    }
  }

  router.get(
    '/snapshot',
    wrap(async (_req, res) => {
      const outcome = await readSnapshotOr422(res);
      if (!outcome.ok) {
        return;
      }
      if (!outcome.snapshot) {
        res.status(404).json({ error: 'never refreshed' });
        return;
      }
      res.json(outcome.snapshot);
    }),
  );

  router.post(
    '/suggest-update',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { config?: unknown };
      const config = body.config as IscConfig | undefined;
      if (!config || typeof config !== 'object') {
        res.status(422).json({ error: 'config object is required' });
        return;
      }
      if (config.kind !== 'ImageSetConfiguration') {
        res
          .status(422)
          .json({ error: 'config.kind must be ImageSetConfiguration' });
        return;
      }
      if (
        typeof config.apiVersion !== 'string' ||
        !config.apiVersion.startsWith('mirror.openshift.io/')
      ) {
        res.status(422).json({
          error: 'config.apiVersion must be a mirror.openshift.io version',
        });
        return;
      }
      const outcome = await readSnapshotOr422(res);
      if (!outcome.ok) {
        return;
      }
      if (!outcome.snapshot) {
        res.status(404).json({ error: 'never refreshed' });
        return;
      }
      const catalogData = await deps.loadCatalogData().catch((error: unknown) => {
        console.warn(
          `ACM suggest-update: catalog data load failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      });
      const result = reconcile(
        config,
        outcome.snapshot,
        buildReconcileCatalog(catalogData),
      );
      res.json(result);
    }),
  );

  return router;
}
