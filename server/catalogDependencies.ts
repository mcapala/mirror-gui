export interface OperatorDependencyRef {
  packageName: string;
  versionRange?: string | null;
}

/** parent package name -> its declared dependency refs (dependencies.json shape). */
export type CatalogDependencyMap = Record<string, OperatorDependencyRef[]>;

export interface DirectDependencies {
  refs: OperatorDependencyRef[];
  /** The "<base>-dependencies"-style package whose deps were merged in, if any. */
  conventionPackage: string | null;
}

/**
 * Direct dependency refs of `parent`: its own dependencies.json entry plus
 * the entry of its convention package (odf-operator -> odf-dependencies,
 * then <name>-dependencies / -dependency / -deps), first match wins.
 * Mirrors the resolution the ISC-builder route has always used.
 */
export function resolveDirectDependencies(
  deps: CatalogDependencyMap,
  parent: string,
): DirectDependencies {
  const refs: OperatorDependencyRef[] = deps[parent] ? [...deps[parent]] : [];
  let conventionPackage: string | null = null;
  const candidates: string[] = [];
  if (parent.endsWith('-operator')) {
    candidates.push(`${parent.replace(/-operator$/, '')}-dependencies`);
  }
  candidates.push(`${parent}-dependencies`, `${parent}-dependency`, `${parent}-deps`);
  for (const name of candidates) {
    if (deps[name]) {
      refs.push(...deps[name]);
      conventionPackage = name;
      break;
    }
  }
  const unique = refs.filter(
    (ref, index, self) =>
      index === self.findIndex(d => d.packageName === ref.packageName),
  );
  return { refs: unique, conventionPackage };
}

/** Dependency package names of `parent` (refs + convention package), parent excluded. */
export function resolveDependencyClosure(
  deps: CatalogDependencyMap,
  parent: string,
): string[] {
  const { refs, conventionPackage } = resolveDirectDependencies(deps, parent);
  const names = refs.map(r => r.packageName);
  if (conventionPackage) {
    names.push(conventionPackage);
  }
  return [...new Set(names)].filter(n => n !== parent);
}
