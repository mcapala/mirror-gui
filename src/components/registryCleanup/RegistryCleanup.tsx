import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Button,
  Checkbox,
  EmptyState,
  EmptyStateBody,
  FormSelect,
  FormSelectOption,
  Label,
  Spinner,
  TextInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { DownloadIcon, PlayIcon } from '@patternfly/react-icons';
import { useAlerts } from '../../AlertContext';
import type { DiscReport, GenerateResponse, MirrorRegistry, OrphanItem } from './types';

function shortDigest(digest: string | null): string {
  if (!digest) return '—';
  return digest.slice(0, 19);
}

interface OrphanRow extends OrphanItem {
  include: boolean;
  editedRef: string;
}

const RegistryCleanup: React.FC = () => {
  const { addDangerAlert } = useAlerts();
  const [registries, setRegistries] = useState<MirrorRegistry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [strict, setStrict] = useState(false);
  const [includeAdditional, setIncludeAdditional] = useState(true);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [strictReport, setStrictReport] = useState<DiscReport | null>(null);
  const [issue, setIssue] = useState<'none' | 'never-scanned' | 'schema-mismatch'>(
    'none',
  );
  const [orphanRows, setOrphanRows] = useState<OrphanRow[]>([]);
  const [acmRefreshedAt, setAcmRefreshedAt] = useState<string | null>(null);
  // Stale-response guard: only apply responses for the currently selected id.
  const requestSeq = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const [mirror, acm] = await Promise.all([
          axios.get('/api/mirror-registries'),
          axios.get('/api/acm/snapshot').catch(() => null),
        ]);
        setRegistries(mirror.data.registries);
        setSelectedId(mirror.data.registries[0]?.id ?? '');
        setAcmRefreshedAt(acm?.data?.refreshedAt ?? null);
      } catch {
        addDangerAlert('Failed to load mirror registries');
      } finally {
        setLoading(false);
      }
    })();
  }, [addDangerAlert]);

  useEffect(() => {
    setResult(null);
    setStrictReport(null);
    setOrphanRows([]);
    setIssue('none');
  }, [selectedId]);

  const generate = useCallback(
    async (picks: Array<{ repo: string; tag: string; sourceRef: string }>) => {
      const seq = ++requestSeq.current;
      const id = selectedId;
      setGenerating(true);
      setStrictReport(null);
      try {
        const response = await axios.post<GenerateResponse>(
          `/api/mirror-registries/${id}/generate-disc`,
          {
            strict,
            includeAdditionalImages: includeAdditional,
            includeOrphans: picks,
          },
        );
        if (seq !== requestSeq.current || id !== selectedId) return;
        setResult(response.data);
        setIssue('none');
        setOrphanRows(prev =>
          response.data.report.additionalImages.orphans.map(o => {
            const existing = prev.find(
              r => r.repo === o.repo && r.tag === o.tag,
            );
            return {
              ...o,
              include: existing?.include ?? false,
              editedRef: existing?.editedRef ?? o.suggestedRef,
            };
          }),
        );
      } catch (error) {
        if (seq !== requestSeq.current || id !== selectedId) return;
        setResult(null);
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          setIssue('never-scanned');
        } else if (axios.isAxiosError(error) && error.response?.status === 422) {
          if (error.response.data?.report) {
            setStrictReport(error.response.data.report as DiscReport);
          } else {
            setIssue('schema-mismatch');
          }
        } else {
          const message = axios.isAxiosError(error)
            ? error.response?.data?.error || error.message
            : String(error);
          addDangerAlert(`Generation failed: ${message}`);
        }
      } finally {
        if (seq === requestSeq.current) setGenerating(false);
      }
    },
    [selectedId, strict, includeAdditional, addDangerAlert],
  );

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.discYaml], { type: 'application/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const host = result.report.host.replace(/[:/]/g, '-');
    a.download = `delete-imageset-config-${host}-${result.report.scannedAt.slice(0, 10)}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <Spinner className="pf-v6-u-m-lg" />;
  }

  const selected = registries.find(r => r.id === selectedId);
  const report = result?.report ?? strictReport;
  const picks = orphanRows
    .filter(r => r.include)
    .map(r => ({ repo: r.repo, tag: r.tag, sourceRef: r.editedRef }));

  return (
    <div className="pf-v6-u-mt-md">
      <Title headingLevel="h3" className="pf-v6-u-mb-sm">
        Registry Cleanup
      </Title>
      <p className="pf-v6-u-mb-md">
        Generate a DeleteImageSetConfiguration for content no managed
        ImageSetConfiguration keeps and no cluster still runs. The DISC only
        ever contains fully-verified entries; everything doubtful is held back
        and reported.
      </p>

      <Toolbar inset={{ default: 'insetNone' }}>
        <ToolbarContent>
          <ToolbarItem>
            <FormSelect
              aria-label="Mirror registry"
              value={selectedId}
              onChange={(_e, value) => setSelectedId(value)}
              style={{ minWidth: '20rem' }}
            >
              {registries.length === 0 && (
                <FormSelectOption value="" label="No mirror registries" />
              )}
              {registries.map(r => (
                <FormSelectOption
                  key={r.id}
                  value={r.id}
                  label={r.pathPrefix ? `${r.host}/${r.pathPrefix}` : r.host}
                />
              ))}
            </FormSelect>
          </ToolbarItem>
          <ToolbarItem>
            <Checkbox
              id="cleanup-include-additional"
              label="Include additionalImages"
              isChecked={includeAdditional}
              onChange={(_e, checked) => setIncludeAdditional(checked)}
            />
          </ToolbarItem>
          <ToolbarItem>
            <Checkbox
              id="cleanup-strict"
              label="Strict mode (fail on unverifiable)"
              isChecked={strict}
              onChange={(_e, checked) => setStrict(checked)}
            />
          </ToolbarItem>
          <ToolbarItem>
            <Button
              variant="primary"
              icon={<PlayIcon />}
              onClick={() => generate(picks)}
              isDisabled={!selectedId || generating}
              isLoading={generating}
            >
              {generating ? 'Generating…' : result ? 'Regenerate' : 'Generate'}
            </Button>
          </ToolbarItem>
          {result && (
            <ToolbarItem>
              <Button variant="secondary" icon={<DownloadIcon />} onClick={download}>
                Download DISC YAML
              </Button>
            </ToolbarItem>
          )}
        </ToolbarContent>
      </Toolbar>

      {acmRefreshedAt === null && (
        <Alert
          variant="info"
          isInline
          className="pf-v6-u-mb-sm"
          title="No fleet snapshot stored — operator candidates will be held back until Fleet Operators is refreshed."
        />
      )}

      {registries.length === 0 && (
        <EmptyState titleText="No mirror registries configured" headingLevel="h4">
          <EmptyStateBody>
            Add a mirror registry on the Registry Content tab first.
          </EmptyStateBody>
        </EmptyState>
      )}

      {selected && issue === 'never-scanned' && (
        <EmptyState titleText="Never scanned" headingLevel="h4">
          <EmptyStateBody>
            Run a scan on the Registry Content tab first — cleanup works from
            the stored scan snapshot.
          </EmptyStateBody>
        </EmptyState>
      )}

      {selected && issue === 'schema-mismatch' && (
        <Alert
          variant="warning"
          isInline
          title="Stored scan is from an incompatible version — scan again on the Registry Content tab."
        />
      )}

      {strictReport && (
        <Alert
          variant="danger"
          isInline
          className="pf-v6-u-mb-sm"
          title="Strict mode: candidates were held back by the fleet gate — no DISC produced."
        />
      )}

      {report && (
        <>
          <div className="pf-v6-u-mb-sm pf-v6-u-mt-sm">
            <Label color="blue" className="pf-v6-u-mr-sm">
              Scan: {new Date(report.scannedAt).toLocaleString()}
            </Label>
            <Label color="blue" className="pf-v6-u-mr-sm">
              Fleet:{' '}
              {report.acmRefreshedAt
                ? new Date(report.acmRefreshedAt).toLocaleString()
                : 'no snapshot'}
            </Label>
            <Label color="green" className="pf-v6-u-mr-sm">
              {report.stats.discOperatorEntries} operator version(s)
            </Label>
            <Label color="green">
              {report.stats.discAdditionalImages} additionalImage(s)
            </Label>
          </div>

          {report.warnings.map((w, i) => (
            <Alert key={i} variant="warning" isInline className="pf-v6-u-mb-sm" title={w} />
          ))}

          <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
            Operator delete candidates
          </Title>
          {report.operators.candidates.length === 0 ? (
            <p>No operator versions are deletable.</p>
          ) : (
            <Table aria-label="Operator delete candidates" variant="compact">
              <Thead>
                <Tr>
                  <Th>Package</Th>
                  <Th>Channel</Th>
                  <Th>Version</Th>
                  <Th>Tag</Th>
                  <Th>Digest</Th>
                  <Th>Catalog</Th>
                </Tr>
              </Thead>
              <Tbody>
                {report.operators.candidates.map(c => (
                  <Tr key={`${c.package}-${c.version}-${c.tag}`}>
                    <Td>{c.package}</Td>
                    <Td>{c.channel}</Td>
                    <Td>{c.version}</Td>
                    <Td>{c.tag}</Td>
                    <Td>{shortDigest(c.digest)}</Td>
                    <Td>{c.catalog}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}

          {(report.operators.held.length > 0 ||
            report.additionalImages.held.length > 0) && (
            <>
              <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
                Held back
              </Title>
              <Table aria-label="Held back items" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Item</Th>
                    <Th>Reason</Th>
                    <Th>Detail</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {[...report.operators.held, ...report.additionalImages.held].map(
                    (h, i) => (
                      <Tr key={i}>
                        <Td>
                          {h.kind === 'operator'
                            ? `${h.package} ${h.version}`
                            : `${h.repo}:${h.tag}`}
                        </Td>
                        <Td>
                          <Label
                            color={h.reason === 'still-deployed' ? 'red' : 'orange'}
                          >
                            {h.reason}
                          </Label>
                        </Td>
                        <Td>{h.detail}</Td>
                      </Tr>
                    ),
                  )}
                </Tbody>
              </Table>
            </>
          )}

          {includeAdditional && report.additionalImages.class1.length > 0 && (
            <>
              <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
                additionalImages (not fleet-verified)
              </Title>
              <Table aria-label="additionalImages candidates" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Repository</Th>
                    <Th>Tag</Th>
                    <Th>Source ref (emitted)</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {report.additionalImages.class1.map(c => (
                    <Tr key={`${c.repo}-${c.tag}`}>
                      <Td>{c.repo}</Td>
                      <Td>{c.tag}</Td>
                      <Td>{c.sourceRef}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </>
          )}

          {orphanRows.length > 0 && (
            <>
              <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
                Orphan review (unknown provenance — opt in per item)
              </Title>
              <Alert
                variant="warning"
                isInline
                className="pf-v6-u-mb-sm"
                title="These repos are in no managed ISC. Confirm the source ref (host is a guess) and tick to include; a wrong host means the image is simply not deleted."
              />
              <Table aria-label="Orphan repos" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Include</Th>
                    <Th>Repository</Th>
                    <Th>Tag</Th>
                    <Th>Source ref</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {orphanRows.map((row, i) => (
                    <Tr key={`${row.repo}-${row.tag}`}>
                      <Td>
                        <Checkbox
                          id={`orphan-${i}`}
                          isChecked={row.include}
                          onChange={(_e, checked) =>
                            setOrphanRows(rows =>
                              rows.map((r, j) =>
                                j === i ? { ...r, include: checked } : r,
                              ),
                            )
                          }
                        />
                      </Td>
                      <Td>{row.repo}</Td>
                      <Td>{row.tag}</Td>
                      <Td>
                        <TextInput
                          aria-label={`Source ref for ${row.repo}:${row.tag}`}
                          value={row.editedRef}
                          onChange={(_e, value) =>
                            setOrphanRows(rows =>
                              rows.map((r, j) =>
                                j === i ? { ...r, editedRef: value } : r,
                              ),
                            )
                          }
                        />
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </>
          )}

          {report.additionalImages.rejectedPicks.length > 0 && (
            <Alert
              variant="danger"
              isInline
              className="pf-v6-u-mt-sm"
              title="Some orphan picks were rejected"
            >
              <ul>
                {report.additionalImages.rejectedPicks.map((p, i) => (
                  <li key={i}>
                    {p.repo}:{p.tag} — {p.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          {(report.operators.unverifiableRepos.length > 0 ||
            report.operators.manualBundles.length > 0 ||
            report.operators.unknownTags.length > 0) && (
            <>
              <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
                Needs manual review
              </Title>
              <ul>
                {report.operators.unverifiableRepos.map((r, i) => (
                  <li key={`u${i}`}>
                    <strong>{r.repo}</strong>: {r.message}
                  </li>
                ))}
                {report.operators.manualBundles.map((m, i) => (
                  <li key={`m${i}`}>
                    <strong>{m.package} {m.bundleName}</strong>: {m.reason}
                  </li>
                ))}
                {report.operators.unknownTags.map((t, i) => (
                  <li key={`t${i}`}>
                    {t.repo}:{t.tag} — unknown tag (never auto-deleted)
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default RegistryCleanup;
