#!/usr/bin/env bash
# Regenerates tests/fixtures/catalog-data/ JSON fixtures from the raw FBC
# mini-fixture in tests/fixtures/catalog-fbc/ using the real generator.
# Committed fixtures are script output — edit the FBC fixture, then re-run this.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FBC_ROOT="${REPO_ROOT}/tests/fixtures/catalog-fbc"
OUT_ROOT="${REPO_ROOT}/tests/fixtures/catalog-data"

for catalog_dir in "${FBC_ROOT}"/*/; do
    catalog_type="$(basename "${catalog_dir}")"
    for version_dir in "${catalog_dir}"*/; do
        ocp_version="$(basename "${version_dir}")"
        out_dir="${OUT_ROOT}/${catalog_type}/${ocp_version}"
        mkdir -p "${out_dir}"
        echo "Regenerating ${catalog_type}/${ocp_version}"
        python3 "${REPO_ROOT}/scripts/catalog_metadata.py" generate \
            --catalog-dir "${version_dir}" \
            --catalog-type "${catalog_type}" \
            --ocp-version "${ocp_version}" \
            --operators-file "${out_dir}/operators.json" \
            --dependencies-file "${out_dir}/dependencies.json" \
            --bundles-file "${out_dir}/bundles.json"
    done
done
echo "Done. Remember: tests/fixtures/catalog-data/catalog-index.json is hand-maintained."
