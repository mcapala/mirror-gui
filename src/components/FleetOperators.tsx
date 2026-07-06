import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  EmptyStateBody,
  Label,
  SearchInput,
  Spinner,
  Title,
  ToggleGroup,
  ToggleGroupItem,
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
import { SyncAltIcon } from '@patternfly/react-icons';
import { useAlerts } from '../AlertContext';

interface Deployment {
  cluster: string;
  hub: string;
  version: string;
  behind: boolean;
}

interface PackageSnapshot {
  deployments: Deployment[];
  minDeployed: string;
  maxDeployed: string;
  latestAvailable: string | null;
  catalogSource: string | null;
  status: 'current' | 'behind' | 'unknown';
}

interface HubStatus {
  id: string;
  name: string;
  status: 'ok' | 'error';
  error: string | null;
  truncated: boolean;
  skippedItems: number;
  clusterCount: number;
}

interface Snapshot {
  schemaVersion: number;
  refreshedAt: string;
  hubs: HubStatus[];
  packages: Record<string, PackageSnapshot>;
}

type StatusFilter = 'all' | 'behind' | 'current' | 'unknown';

const statusColor: Record<
  PackageSnapshot['status'],
  'green' | 'orange' | 'grey'
> = {
  current: 'green',
  behind: 'orange',
  unknown: 'grey',
};

const FleetOperators: React.FC = () => {
  const { addDangerAlert } = useAlerts();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [neverRefreshed, setNeverRefreshed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadSnapshot = useCallback(async () => {
    try {
      const response = await axios.get('/api/acm/snapshot');
      setSnapshot(response.data);
      setNeverRefreshed(false);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        setNeverRefreshed(true);
      } else {
        addDangerAlert('Failed to load fleet snapshot');
      }
    } finally {
      setLoading(false);
    }
  }, [addDangerAlert]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const response = await axios.post('/api/acm/refresh');
      setSnapshot(response.data);
      setNeverRefreshed(false);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.error || error.message;
        addDangerAlert(`Refresh failed: ${message}`);
      } else {
        addDangerAlert('Refresh failed');
      }
    } finally {
      setRefreshing(false);
    }
  };

  const rows = useMemo(() => {
    if (!snapshot) return [];
    return Object.entries(snapshot.packages)
      .filter(([name]) => name.toLowerCase().includes(filter.toLowerCase()))
      .filter(
        ([, pkg]) => statusFilter === 'all' || pkg.status === statusFilter,
      )
      .sort(([a], [b]) => a.localeCompare(b));
  }, [snapshot, filter, statusFilter]);

  const toggleExpanded = (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  if (loading) {
    return <Spinner aria-label="Loading fleet snapshot" />;
  }

  return (
    <>
      <Card>
        <CardBody>
          <Title headingLevel="h2">Fleet Operators</Title>
          <p>
            Operator versions deployed across all managed clusters, aggregated
            from the configured ACM hubs.
          </p>
        </CardBody>
      </Card>

      <Card className="pf-v6-u-mt-lg">
        <CardBody>
          <Toolbar>
            <ToolbarContent>
              <ToolbarItem>
                <Button
                  variant="primary"
                  icon={<SyncAltIcon />}
                  onClick={refresh}
                  isLoading={refreshing}
                  isDisabled={refreshing}
                >
                  Refresh
                </Button>
              </ToolbarItem>
              {snapshot && (
                <ToolbarItem>
                  Data as of {new Date(snapshot.refreshedAt).toLocaleString()}
                </ToolbarItem>
              )}
              {snapshot?.hubs.map(hub => (
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
                    <Label color="green">
                      {hub.name}: {hub.clusterCount} clusters
                    </Label>
                  )}
                </ToolbarItem>
              ))}
            </ToolbarContent>
          </Toolbar>

          {neverRefreshed ? (
            <EmptyState titleText="No snapshot yet" headingLevel="h4">
              <EmptyStateBody>
                Click Refresh to query the configured ACM hubs. If no hubs are
                configured yet, add them under Settings → ACM Hubs.
              </EmptyStateBody>
            </EmptyState>
          ) : (
            <>
              <Toolbar>
                <ToolbarContent>
                  <ToolbarItem>
                    <SearchInput
                      aria-label="Filter packages"
                      placeholder="Filter by package name"
                      value={filter}
                      onChange={(_e, value) => setFilter(value)}
                      onClear={() => setFilter('')}
                    />
                  </ToolbarItem>
                  <ToolbarItem>
                    <ToggleGroup aria-label="Status filter">
                      {(['all', 'behind', 'current', 'unknown'] as const).map(
                        value => (
                          <ToggleGroupItem
                            key={value}
                            text={value}
                            isSelected={statusFilter === value}
                            onChange={() => setStatusFilter(value)}
                          />
                        ),
                      )}
                    </ToggleGroup>
                  </ToolbarItem>
                </ToolbarContent>
              </Toolbar>

              <Table aria-label="Fleet operator versions">
                <Thead>
                  <Tr>
                    <Th screenReaderText="Expand" />
                    <Th>Package</Th>
                    <Th>Deployed range</Th>
                    <Th>Clusters</Th>
                    <Th>Latest available</Th>
                    <Th>Status</Th>
                  </Tr>
                </Thead>
                {rows.map(([name, pkg], rowIndex) => (
                  <Tbody key={name} isExpanded={expanded.has(name)}>
                    <Tr>
                      <Td
                        expand={{
                          rowIndex,
                          isExpanded: expanded.has(name),
                          onToggle: () => toggleExpanded(name),
                        }}
                      />
                      <Td dataLabel="Package">{name}</Td>
                      <Td dataLabel="Deployed range">
                        {pkg.minDeployed === pkg.maxDeployed
                          ? pkg.minDeployed
                          : `${pkg.minDeployed} → ${pkg.maxDeployed}`}
                      </Td>
                      <Td dataLabel="Clusters">{pkg.deployments.length}</Td>
                      <Td dataLabel="Latest available">
                        {pkg.latestAvailable ?? '—'}
                      </Td>
                      <Td dataLabel="Status">
                        <Tooltip
                          content={
                            pkg.status === 'unknown'
                              ? 'Not found in any bundled catalog, or versions are not comparable'
                              : pkg.status === 'behind'
                                ? 'At least one cluster is below the latest available version'
                                : 'All clusters are on the latest available version'
                          }
                        >
                          <Label color={statusColor[pkg.status]}>
                            {pkg.status}
                          </Label>
                        </Tooltip>
                      </Td>
                    </Tr>
                    <Tr isExpanded={expanded.has(name)}>
                      <Td />
                      <Td colSpan={5}>
                        <ExpandableRowContent>
                          <Table
                            aria-label={`Deployments of ${name}`}
                            variant="compact"
                          >
                            <Thead>
                              <Tr>
                                <Th>Cluster</Th>
                                <Th>Hub</Th>
                                <Th>Version</Th>
                              </Tr>
                            </Thead>
                            <Tbody>
                              {pkg.deployments.map(deployment => (
                                <Tr
                                  key={`${deployment.hub}-${deployment.cluster}`}
                                >
                                  <Td dataLabel="Cluster">
                                    {deployment.cluster}
                                  </Td>
                                  <Td dataLabel="Hub">{deployment.hub}</Td>
                                  <Td dataLabel="Version">
                                    {deployment.behind ? (
                                      <Label color="orange" isCompact>
                                        {deployment.version}
                                      </Label>
                                    ) : (
                                      deployment.version
                                    )}
                                  </Td>
                                </Tr>
                              ))}
                            </Tbody>
                          </Table>
                        </ExpandableRowContent>
                      </Td>
                    </Tr>
                  </Tbody>
                ))}
              </Table>
              {rows.length === 0 && (
                <EmptyState titleText="No packages match" headingLevel="h4">
                  <EmptyStateBody>
                    No deployed operators match the current filters.
                  </EmptyStateBody>
                </EmptyState>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </>
  );
};

export default FleetOperators;
