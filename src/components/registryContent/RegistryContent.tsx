import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  EmptyState,
  EmptyStateBody,
  ExpandableSection,
  FormSelect,
  FormSelectOption,
  Label,
  Spinner,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { SyncAltIcon } from '@patternfly/react-icons';
import { useAlerts } from '../../AlertContext';
import type { MirrorRegistry, OperatorContentReport } from './types';

function shortDigest(digest: string | null): string {
  if (!digest) return '—';
  return digest.replace(/^sha256:/, 'sha256:').slice(0, 19);
}

const RegistryContent: React.FC = () => {
  const { addSuccessAlert, addDangerAlert } = useAlerts();
  const [registries, setRegistries] = useState<MirrorRegistry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<OperatorContentReport | null>(null);
  const [reportIssue, setReportIssue] = useState<
    'none' | 'never-scanned' | 'schema-mismatch'
  >('none');

  const loadRegistries = useCallback(async () => {
    try {
      const mirror = await axios.get('/api/mirror-registries');
      setRegistries(mirror.data.registries);
      setSelectedId(prev =>
        mirror.data.registries.some((r: MirrorRegistry) => r.id === prev)
          ? prev
          : (mirror.data.registries[0]?.id ?? ''),
      );
    } catch {
      addDangerAlert('Failed to load mirror registries');
    } finally {
      setLoading(false);
    }
  }, [addDangerAlert]);

  const loadReport = useCallback(
    async (id: string) => {
      if (!id) {
        setReport(null);
        return;
      }
      try {
        const response = await axios.get(
          `/api/mirror-registries/${id}/operator-content`,
        );
        setReport(response.data);
        setReportIssue('none');
      } catch (error) {
        setReport(null);
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          setReportIssue('never-scanned');
        } else if (
          axios.isAxiosError(error) &&
          error.response?.status === 422
        ) {
          setReportIssue('schema-mismatch');
        } else {
          addDangerAlert('Failed to load registry content');
        }
      }
    },
    [addDangerAlert],
  );

  useEffect(() => {
    loadRegistries();
  }, [loadRegistries]);

  useEffect(() => {
    loadReport(selectedId);
  }, [selectedId, loadReport]);

  const scan = async () => {
    setScanning(true);
    try {
      await axios.post(`/api/mirror-registries/${selectedId}/scan`);
      addSuccessAlert('Registry scan complete');
      await loadReport(selectedId);
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      addDangerAlert(`Scan failed: ${message}`);
    } finally {
      setScanning(false);
    }
  };

  if (loading) {
    return <Spinner className="pf-v6-u-m-lg" />;
  }

  const selected = registries.find(r => r.id === selectedId);

  return (
    <div className="pf-v6-u-mt-md">
      <Title headingLevel="h3" className="pf-v6-u-mb-sm">
        Registry Content
      </Title>
      <p className="pf-v6-u-mb-md">
        Scan a mirror registry and map its operator bundle content back to
        catalog versions.
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
            <Button
              variant="primary"
              icon={<SyncAltIcon />}
              onClick={scan}
              isDisabled={!selectedId || scanning}
              isLoading={scanning}
            >
              {scanning ? 'Scanning…' : 'Scan now'}
            </Button>
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>

      {registries.length === 0 && (
        <EmptyState titleText="No mirror registries configured" headingLevel="h4">
          <EmptyStateBody>
            Configure mirror registries (host, path prefix, and credentials) in{' '}
            <Link to="/settings?tab=registry">Settings → Registry</Link>.
          </EmptyStateBody>
        </EmptyState>
      )}

      {selected && reportIssue === 'never-scanned' && (
        <EmptyState titleText="Never scanned" headingLevel="h4">
          <EmptyStateBody>
            Run a scan to map this registry's content to catalog versions.
          </EmptyStateBody>
        </EmptyState>
      )}

      {selected && reportIssue === 'schema-mismatch' && (
        <Alert
          variant="warning"
          isInline
          title="Stored scan is from an incompatible version — scan again to rebuild it."
        />
      )}

      {report && (
        <>
          <div className="pf-v6-u-mb-sm">
            <Label color="blue" className="pf-v6-u-mr-sm">
              Scanned {new Date(report.scannedAt).toLocaleString()}
            </Label>
            <Label color="grey" className="pf-v6-u-mr-sm">
              {report.stats.reposPresent}/{report.stats.reposExpected} repos
              present
            </Label>
            <Label color="green" className="pf-v6-u-mr-sm">
              {report.stats.matched} matched
            </Label>
            <Label color={report.stats.unknown ? 'orange' : 'grey'}>
              {report.stats.unknown} unknown
            </Label>
          </div>

          {report.partial && (
            <Alert
              variant="warning"
              isInline
              className="pf-v6-u-mb-sm"
              title={`Partial scan — ${report.errors.length} issue(s)`}
            >
              <ul>
                {report.errors.map((e, i) => (
                  <li key={i}>
                    {e.repo ?? e.catalog}: {e.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
            Matched content
          </Title>
          {Object.keys(report.packages).length === 0 ? (
            <p>No catalog-matched content found in this registry.</p>
          ) : (
            <Table aria-label="Matched registry content" variant="compact">
              <Thead>
                <Tr>
                  <Th>Package</Th>
                  <Th>Version</Th>
                  <Th>Tag</Th>
                  <Th>Digest</Th>
                  <Th>Catalog</Th>
                </Tr>
              </Thead>
              <Tbody>
                {Object.entries(report.packages).flatMap(([pkg, versions]) =>
                  versions.map(v => (
                    <Tr key={`${pkg}-${v.tag}-${v.repo}`}>
                      <Td>{pkg}</Td>
                      <Td>{v.version ?? '—'}</Td>
                      <Td>{v.tag}</Td>
                      <Td>{shortDigest(v.digest)}</Td>
                      <Td>{v.catalog}</Td>
                    </Tr>
                  )),
                )}
              </Tbody>
            </Table>
          )}

          {report.unknownTags.length > 0 && (
            <>
              <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
                Unknown tags
              </Title>
              <Alert
                variant="warning"
                isInline
                className="pf-v6-u-mb-sm"
                title="not referenced by any current catalog — manual review only, never auto-delete"
              />
              <Table aria-label="Unknown registry tags" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Repository</Th>
                    <Th>Tag</Th>
                    <Th>Digest</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {report.unknownTags.map(u => (
                    <Tr key={`${u.repo}-${u.tag}`}>
                      <Td>{u.repo}</Td>
                      <Td>{u.tag}</Td>
                      <Td>{shortDigest(u.digest)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </>
          )}

          {report.supportImages.length > 0 && (
            <ExpandableSection
              className="pf-v6-u-mt-md"
              toggleText={`Operator support images (${report.supportImages.length})`}
            >
              <Table aria-label="Operator support images" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Repository</Th>
                    <Th>Tag</Th>
                    <Th>Digest</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {report.supportImages.map(s => (
                    <Tr key={`${s.repo}:${s.tag}`}>
                      <Td>{s.repo}</Td>
                      <Td>{s.tag}</Td>
                      <Td>{shortDigest(s.digest)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </ExpandableSection>
          )}

          {report.platformImages.length > 0 && (
            <ExpandableSection
              className="pf-v6-u-mt-md"
              toggleText={`Platform images (${report.platformImages.length})`}
            >
              <Table aria-label="Platform images" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Repository</Th>
                    <Th>Tag</Th>
                    <Th>Digest</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {report.platformImages.map(p => (
                    <Tr key={`${p.repo}:${p.tag}`}>
                      <Td>{p.repo}</Td>
                      <Td>{p.tag}</Td>
                      <Td>{shortDigest(p.digest)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </ExpandableSection>
          )}

          <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">
            Additional images{' '}
            <Label color={report.additionalImages.length ? 'blue' : 'grey'}>
              {report.additionalImages.length}
            </Label>
          </Title>
          {!report.walkOk && (
            <Alert
              variant="warning"
              isInline
              className="pf-v6-u-mb-sm"
              title="Catalog walk unavailable on this registry — this list only covers images referenced by your configurations."
            />
          )}
          {report.additionalImages.length === 0 ? (
            <p>No non-operator images found in this registry.</p>
          ) : (
            <Table aria-label="Additional registry images" variant="compact">
              <Thead>
                <Tr>
                  <Th>Repository</Th>
                  <Th>Tag</Th>
                  <Th>Digest</Th>
                  <Th>Source image</Th>
                </Tr>
              </Thead>
              <Tbody>
                {report.additionalImages.map(a => (
                  // ':' is illegal in repo paths, so the key cannot collide.
                  <Tr key={`${a.repo}:${a.tag}`}>
                    <Td>{a.repo}</Td>
                    <Td>{a.tag}</Td>
                    <Td>{shortDigest(a.digest)}</Td>
                    <Td>{a.source ?? '—'}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </>
      )}
    </div>
  );
};

export default RegistryContent;
