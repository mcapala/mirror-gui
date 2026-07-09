import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Button,
  Checkbox,
  EmptyState,
  EmptyStateBody,
  ExpandableSection,
  Label,
  List,
  ListItem,
  Spinner,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Tooltip,
} from '@patternfly/react-core';
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  ExpandableRowContent,
} from '@patternfly/react-table';
import { SyncAltIcon, InfoCircleIcon } from '@patternfly/react-icons';
import { useAlerts } from '../../AlertContext';
import type { ImageSetConfig } from '../MirrorConfig';
import type { ReconcileResult, SnapshotMeta, Suggestion } from './types';
import { applySuggestions } from './applySuggestions';

interface FleetUpdatesProps {
  config: ImageSetConfig;
  setConfig: React.Dispatch<React.SetStateAction<ImageSetConfig>>;
}

const kindLabel: Record<Suggestion['kind'], string> = {
  'raise-min-version': 'Raise minVersion',
  'lower-min-version-drift': 'Drift: lower minVersion',
  'raise-platform-min-version': 'Raise platform minVersion',
  'add-channel': 'Add channel',
  'add-operator': 'Add operator',
  'remove-channel': 'Remove channel',
  'reset-unused-operator': 'Reset unused operator',
};

const kindColor: Record<
  Suggestion['kind'],
  'blue' | 'red' | 'grey' | 'purple'
> = {
  'raise-min-version': 'blue',
  'lower-min-version-drift': 'red',
  'raise-platform-min-version': 'blue',
  'add-channel': 'purple',
  'add-operator': 'purple',
  'remove-channel': 'grey',
  'reset-unused-operator': 'grey',
};

function pathText(path: Suggestion['path']): string {
  if (path.type === 'platform-channel') return `platform / ${path.channel}`;
  if (path.type === 'operator') return path.package;
  return `${path.package} / ${path.channel}`;
}

const FleetUpdates: React.FC<FleetUpdatesProps> = ({ config, setConfig }) => {
  const { addSuccessAlert, addDangerAlert, addWarningAlert } = useAlerts();
  const [meta, setMeta] = useState<SnapshotMeta | null>(null);
  const [snapshotIssue, setSnapshotIssue] = useState<
    'none' | 'never-refreshed' | 'schema-mismatch'
  >('none');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadMeta = useCallback(async () => {
    try {
      const response = await axios.get('/api/acm/snapshot');
      setMeta({
        refreshedAt: response.data.refreshedAt,
        hubs: response.data.hubs,
      });
      setSnapshotIssue('none');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        setSnapshotIssue('never-refreshed');
      } else if (axios.isAxiosError(error) && error.response?.status === 422) {
        setSnapshotIssue('schema-mismatch');
      } else {
        addDangerAlert('Failed to load fleet snapshot status');
      }
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [addDangerAlert]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const response = await axios.post('/api/acm/refresh');
      setMeta({
        refreshedAt: response.data.refreshedAt,
        hubs: response.data.hubs,
      });
      setSnapshotIssue('none');
      setResult(null);
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      addDangerAlert(`Refresh failed: ${message}`);
    } finally {
      setRefreshing(false);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    try {
      const response = await axios.post('/api/acm/suggest-update', { config });
      const data: ReconcileResult = response.data;
      setResult(data);
      setChecked(
        new Set(data.suggestions.filter(s => s.defaultChecked).map(s => s.id)),
      );
      setExpanded(new Set());
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      addDangerAlert(`Suggest updates failed: ${message}`);
    } finally {
      setSuggesting(false);
    }
  };

  const apply = () => {
    if (!result) return;
    const chosen = result.suggestions.filter(s => checked.has(s.id));
    const { config: next, applied, skipped } = applySuggestions(config, chosen);
    setConfig(next);
    if (skipped.length > 0) {
      addWarningAlert(
        `${skipped.length} suggestion(s) no longer applied cleanly: ${skipped.join('; ')}`,
      );
    }
    addSuccessAlert(
      `${applied} change(s) applied — review in the Preview tab and save explicitly`,
    );
    setResult(null);
  };

  const toggle = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (!result) return;
    setChecked(prev =>
      prev.size === result.suggestions.length
        ? new Set()
        : new Set(result.suggestions.map(s => s.id)),
    );
  };

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="pf-v6-u-text-align-center pf-v6-u-mt-2xl">
        <Spinner aria-label="Loading fleet data" />
      </div>
    );
  }

  return (
    <div className="pf-v6-u-mt-lg">
      <Title headingLevel="h3" className="pf-v6-u-mb-sm">
        Fleet Updates
      </Title>
      <p className="pf-v6-u-mb-md">
        Reconcile this configuration against the deployed fleet (ACM snapshot)
        and the bundled catalogs. Applied changes only modify the editor —
        saving stays explicit.
      </p>

      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <Button
              variant="secondary"
              icon={<SyncAltIcon />}
              onClick={refresh}
              isLoading={refreshing}
              isDisabled={refreshing || suggesting}
            >
              Refresh fleet data
            </Button>
          </ToolbarItem>
          {meta && (
            <ToolbarItem>
              Fleet data as of {new Date(meta.refreshedAt).toLocaleString()}
            </ToolbarItem>
          )}
          {meta?.hubs.map(hub => (
            <ToolbarItem key={hub.id}>
              {hub.status === 'error' ? (
                <Tooltip content={hub.error ?? 'query failed'}>
                  <Label color="red">{hub.name}: error</Label>
                </Tooltip>
              ) : hub.truncated ? (
                <Tooltip content="Results hit the search limit — data may be incomplete">
                  <Label color="yellow">{hub.name}: truncated</Label>
                </Tooltip>
              ) : (
                <Label color="green">{hub.name}: ok</Label>
              )}
            </ToolbarItem>
          ))}
          <ToolbarItem>
            <Button
              variant="primary"
              onClick={suggest}
              isLoading={suggesting}
              isDisabled={suggesting || refreshing || snapshotIssue !== 'none'}
            >
              Suggest updates
            </Button>
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>

      {snapshotIssue === 'never-refreshed' && (
        <EmptyState titleText="No fleet snapshot yet" headingLevel="h4">
          <EmptyStateBody>
            Click &quot;Refresh fleet data&quot; to query the configured ACM
            hubs. If no hubs are configured, add them under Settings → ACM Hubs.
          </EmptyStateBody>
        </EmptyState>
      )}
      {snapshotIssue === 'schema-mismatch' && (
        <EmptyState titleText="Snapshot needs a refresh" headingLevel="h4">
          <EmptyStateBody>
            The stored fleet snapshot was written by an older version. Click
            &quot;Refresh fleet data&quot; to rebuild it.
          </EmptyStateBody>
        </EmptyState>
      )}

      {result && (
        <>
          {result.warnings.length > 0 && (
            <ExpandableSection
              toggleText={`${result.warnings.length} notice${
                result.warnings.length === 1 ? '' : 's'
              }`}
              className="pf-v6-u-mt-md"
            >
              <List>
                {result.warnings.map((warning, i) => (
                  <ListItem key={i}>{warning}</ListItem>
                ))}
              </List>
            </ExpandableSection>
          )}

          {result.suggestions.length === 0 ? (
            <EmptyState titleText="Nothing to change" headingLevel="h4">
              <EmptyStateBody>
                The configuration already matches the deployed fleet.
              </EmptyStateBody>
            </EmptyState>
          ) : (
            <>
              <Table aria-label="Update suggestions" className="pf-v6-u-mt-md">
                <Thead>
                  <Tr>
                    <Th screenReaderText="Notes" />
                    <Th>
                      <Checkbox
                        id="sugg-select-all"
                        aria-label="Select all suggestions"
                        isChecked={
                          checked.size === result.suggestions.length
                            ? true
                            : checked.size === 0
                              ? false
                              : null
                        }
                        onChange={toggleAll}
                      />
                    </Th>
                    <Th>Change</Th>
                    <Th>Target</Th>
                    <Th>Current</Th>
                    <Th>Proposed</Th>
                    <Th>Why</Th>
                  </Tr>
                </Thead>
                {result.suggestions.map((suggestion, rowIndex) => (
                  <Tbody
                    key={suggestion.id}
                    isExpanded={expanded.has(suggestion.id)}
                  >
                    <Tr>
                      <Td
                        expand={
                          suggestion.notes?.length
                            ? {
                                rowIndex,
                                isExpanded: expanded.has(suggestion.id),
                                onToggle: () => toggleExpanded(suggestion.id),
                                expandId: 'sugg-notes-',
                              }
                            : undefined
                        }
                      />
                      <Td>
                        <Checkbox
                          id={`sugg-${suggestion.id}`}
                          aria-label={`Apply ${kindLabel[suggestion.kind]} to ${pathText(suggestion.path)}`}
                          isChecked={checked.has(suggestion.id)}
                          onChange={() => toggle(suggestion.id)}
                        />
                      </Td>
                      <Td dataLabel="Change">
                        <Label color={kindColor[suggestion.kind]} isCompact>
                          {kindLabel[suggestion.kind]}
                        </Label>
                      </Td>
                      <Td dataLabel="Target">{pathText(suggestion.path)}</Td>
                      <Td dataLabel="Current">{suggestion.current ?? '—'}</Td>
                      <Td dataLabel="Proposed">{suggestion.proposed ?? '—'}</Td>
                      <Td dataLabel="Why">
                        {suggestion.evidence}
                        {suggestion.notes?.length ? (
                          <InfoCircleIcon
                            className="pf-v6-u-ml-sm"
                            aria-label="Has notes"
                          />
                        ) : null}
                      </Td>
                    </Tr>
                    {suggestion.notes?.length ? (
                      <Tr isExpanded={expanded.has(suggestion.id)}>
                        <Td />
                        <Td colSpan={6}>
                          <ExpandableRowContent>
                            <List>
                              {suggestion.notes.map((note, i) => (
                                <ListItem key={i}>{note}</ListItem>
                              ))}
                            </List>
                          </ExpandableRowContent>
                        </Td>
                      </Tr>
                    ) : null}
                  </Tbody>
                ))}
              </Table>
              <Button
                variant="primary"
                className="pf-v6-u-mt-md"
                onClick={apply}
                isDisabled={checked.size === 0}
              >
                Apply selected ({checked.size})
              </Button>
            </>
          )}

          {result.report.length > 0 && (
            <>
              <Title headingLevel="h4" className="pf-v6-u-mt-lg">
                Clusters behind latest
              </Title>
              <Table aria-label="Clusters behind" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Package</Th>
                    <Th>Latest available</Th>
                    <Th>Behind clusters</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {result.report.map(entry => (
                    <Tr key={entry.package}>
                      <Td dataLabel="Package">{entry.package}</Td>
                      <Td dataLabel="Latest available">
                        {entry.latestAvailable ?? '—'}
                      </Td>
                      <Td dataLabel="Behind clusters">
                        {entry.behindClusters
                          .map(c => `${c.cluster} (${c.version})`)
                          .join(', ')}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </>
          )}

          {result.noData.length > 0 && (
            <Alert
              variant="info"
              isInline
              className="pf-v6-u-mt-md"
              title="Packages without reconciliation data"
            >
              {result.noData
                .map(entry => `${entry.package} (${entry.reason})`)
                .join(', ')}
            </Alert>
          )}
        </>
      )}
    </div>
  );
};

export default FleetUpdates;
