import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Button,
  Checkbox,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Label,
  Spinner,
  TextArea,
  TextInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { PlusCircleIcon, SyncAltIcon, TrashIcon } from '@patternfly/react-icons';
import { useAlerts } from '../../AlertContext';
import type {
  MirrorRegistry,
  OperatorContentReport,
  PullSecretRegistry,
} from './types';

function shortDigest(digest: string | null): string {
  if (!digest) return '—';
  return digest.replace(/^sha256:/, 'sha256:').slice(0, 19);
}

const RegistryContent: React.FC = () => {
  const { addSuccessAlert, addDangerAlert } = useAlerts();
  const [registries, setRegistries] = useState<MirrorRegistry[]>([]);
  const [pullSecretHosts, setPullSecretHosts] = useState<PullSecretRegistry[]>(
    [],
  );
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<OperatorContentReport | null>(null);
  const [reportIssue, setReportIssue] = useState<
    'none' | 'never-scanned' | 'schema-mismatch'
  >('none');
  const [formOpen, setFormOpen] = useState(false);
  const [formHost, setFormHost] = useState('');
  const [formPrefix, setFormPrefix] = useState('');
  const [formSkipVerify, setFormSkipVerify] = useState(false);
  const [formCaBundle, setFormCaBundle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadRegistries = useCallback(async () => {
    try {
      const [mirror, pullSecret] = await Promise.all([
        axios.get('/api/mirror-registries'),
        axios.get('/api/registries'),
      ]);
      setRegistries(mirror.data.registries);
      setPullSecretHosts(pullSecret.data.registries ?? []);
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
    setConfirmDelete(false);
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

  const addRegistry = async () => {
    try {
      const response = await axios.post('/api/mirror-registries', {
        host: formHost,
        pathPrefix: formPrefix,
        insecureSkipVerify: formSkipVerify,
        caBundle: formCaBundle || undefined,
      });
      addSuccessAlert(`Registry ${formHost} added`);
      setFormOpen(false);
      setFormHost('');
      setFormPrefix('');
      setFormSkipVerify(false);
      setFormCaBundle('');
      await loadRegistries();
      setSelectedId(response.data.registry.id);
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      addDangerAlert(`Failed to add registry: ${message}`);
    }
  };

  const deleteRegistry = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await axios.delete(`/api/mirror-registries/${selectedId}`);
      addSuccessAlert('Registry removed');
      setConfirmDelete(false);
      await loadRegistries();
    } catch {
      addDangerAlert('Failed to remove registry');
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
          <ToolbarItem>
            <Button
              variant="secondary"
              icon={<PlusCircleIcon />}
              onClick={() => setFormOpen(open => !open)}
            >
              Add registry
            </Button>
          </ToolbarItem>
          {selectedId && (
            <ToolbarItem>
              <Button
                variant={confirmDelete ? 'danger' : 'secondary'}
                icon={<TrashIcon />}
                onClick={deleteRegistry}
              >
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </Button>
            </ToolbarItem>
          )}
        </ToolbarContent>
      </Toolbar>

      {formOpen && (
        <Form isHorizontal className="pf-v6-u-mb-md" style={{ maxWidth: 640 }}>
          <FormGroup label="Registry host" isRequired fieldId="registry-host">
            <FormSelect
              id="registry-host"
              value={formHost}
              onChange={(_e, value) => setFormHost(value)}
            >
              <FormSelectOption value="" label="Select a pull-secret host…" />
              {pullSecretHosts
                .filter(h => h.hasAuth)
                .map(h => (
                  <FormSelectOption
                    key={h.registry}
                    value={h.registry}
                    label={h.registry}
                  />
                ))}
            </FormSelect>
          </FormGroup>
          <FormGroup
            label="Path prefix"
            fieldId="registry-prefix"
          >
            <TextInput
              id="registry-prefix"
              value={formPrefix}
              onChange={(_e, value) => setFormPrefix(value)}
              placeholder="e.g. mirror — empty for registry root"
            />
          </FormGroup>
          <FormGroup fieldId="registry-skip-verify">
            <Checkbox
              id="registry-skip-verify"
              label="Skip TLS verification (insecure)"
              isChecked={formSkipVerify}
              onChange={(_e, checked) => setFormSkipVerify(checked)}
            />
          </FormGroup>
          <FormGroup label="CA bundle (PEM)" fieldId="registry-ca">
            <TextArea
              id="registry-ca"
              value={formCaBundle}
              onChange={(_e, value) => setFormCaBundle(value)}
              rows={3}
            />
          </FormGroup>
          <div>
            <Button
              variant="primary"
              onClick={addRegistry}
              isDisabled={!formHost}
            >
              Save registry
            </Button>
          </div>
        </Form>
      )}

      {registries.length === 0 && (
        <EmptyState titleText="No mirror registries configured" headingLevel="h4">
          <EmptyStateBody>
            Add a mirror registry (host from your pull secret plus the path
            prefix used when pushing the mirror) to scan its operator content.
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
        </>
      )}
    </div>
  );
};

export default RegistryContent;
