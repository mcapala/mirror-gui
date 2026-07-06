export interface ParsedCsvName {
  packageName: string;
  version: string;
}

// A CSV name encodes the OLM package and version in one of two forms:
//   <package>.v<version>   e.g. advanced-cluster-management.v2.10.3
//   <package>.<version>    e.g. costmanagement-metrics-operator.4.3.1
// The package part is matched non-greedily so it stops at the first dot
// followed by an (optionally v-prefixed) numeric x.y... version.
const CSV_NAME_PATTERN = /^(.+?)\.v?(\d+(?:\.\d+)+(?:[-+.][0-9A-Za-z.+-]*)?)$/;

export function parseCsvName(name: string): ParsedCsvName | null {
  const match = CSV_NAME_PATTERN.exec(name);
  if (!match) {
    return null;
  }
  return { packageName: match[1], version: match[2] };
}
