import { Fragment, useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  PageSection,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Select,
  SelectOption,
  SelectList,
  MenuToggle,
  Label,
  Button,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  CodeBlock,
  CodeBlockCode,
  Alert,
  Spinner,
  Title,
  EmptyState,
  EmptyStateBody,
} from '@patternfly/react-core';
import {
  HistoryIcon,
  SearchIcon,
  DownloadIcon,
  AngleRightIcon,
  AngleDownIcon,
  AngleUpIcon,
  OutlinedClockIcon,
  ListIcon,
} from '@patternfly/react-icons';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { useAlerts } from '../AlertContext';

interface Operation {
  id: string;
  name: string;
  configFile: string;
  status: 'running' | 'success' | 'failed' | 'stopped';
  startedAt: string;
  completedAt?: string;
  duration?: number;
  errorMessage?: string;
}

interface OperationDetails {
  imagesMirrored?: number;
  operatorsMirrored?: number;
  totalSize?: number;
  platformImages?: number;
  additionalImages?: number;
  helmCharts?: number;
  configFile?: string;
  status?: string;
}

const History: React.FC = () => {
  const { addDangerAlert } = useAlerts();

  const [operations, setOperations] = useState<Operation[]>([]);
  const [selectedOperation, setSelectedOperation] = useState<Operation | null>(null);
  const [operationDetails, setOperationDetails] = useState<OperationDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [filterSelectOpen, setFilterSelectOpen] = useState(false);
  const [liveLog, setLiveLog] = useState('');
  const [logSource, setLogSource] = useState<EventSource | null>(null);
  const operationRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const logRef = useRef<HTMLDivElement>(null);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const response = await axios.get('/api/operations/history');
      setOperations(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      console.error('Error fetching history:', error);
      addDangerAlert('Failed to load operation history');
    } finally {
      setLoading(false);
    }
  }, [addDangerAlert]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    if (!selectedOperation) return;
    setLiveLog('');
    if (logSource) {
      logSource.close();
      setLogSource(null);
    }

    axios.get(`/api/operations/${selectedOperation.id}/logs`).then(res => {
      setLiveLog(res.data.logs || '');
    }).catch(err => {
      console.error('Error fetching logs:', err);
      setLiveLog('No logs available for this operation.');
    });

    if (selectedOperation.status === 'running') {
      try {
        const es = new EventSource(`/api/operations/${selectedOperation.id}/logstream`);
        es.onmessage = (e) => {
          setLiveLog((prev) => `${prev}${e.data ? `${e.data}\n` : ''}`);
        };
        es.onerror = () => {
          es.close();
        };
        setLogSource(es);
        return () => {
          es.close();
        };
      } catch (error) {
        console.error('Error setting up SSE connection:', error);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOperation]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [liveLog]);

  const scrollToSelectedOperation = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (!selectedOperation) {
      return;
    }

    const selectedRow = operationRowRefs.current[selectedOperation.id];
    if (!selectedRow) {
      return;
    }

    const main = document.querySelector('main.pf-v6-c-page__main');
    if (main instanceof HTMLElement) {
      const mainRect = main.getBoundingClientRect();
      const rowRect = selectedRow.getBoundingClientRect();
      const targetTop = rowRect.top - mainRect.top + main.scrollTop - 16;

      main.scrollTo({
        top: Math.max(targetTop, 0),
        behavior,
      });

      return;
    }

    selectedRow.scrollIntoView({
      behavior,
      block: 'start',
    });
  }, [selectedOperation]);

  useEffect(() => {
    if (!selectedOperation) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollToSelectedOperation('smooth');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [selectedOperation, scrollToSelectedOperation]);

  const fetchOperationDetails = async (operationId: string) => {
    try {
      const response = await axios.get(`/api/operations/${operationId}/details`);
      setOperationDetails(response.data);
    } catch (error) {
      console.error('Error fetching operation details:', error);
      const operation = operations.find(op => op.id === operationId);
      if (operation) {
        setOperationDetails({
          imagesMirrored: 0,
          operatorsMirrored: 0,
          totalSize: 0,
          platformImages: 0,
          additionalImages: 0,
          helmCharts: 0,
          configFile: operation.configFile,
          status: operation.status,
        });
      }
    }
  };

  const clearSelectedOperation = () => {
    if (logSource) {
      logSource.close();
      setLogSource(null);
    }

    setSelectedOperation(null);
    setOperationDetails(null);
    setLiveLog('');
  };

  const handleOperationSelect = (operation: Operation) => {
    setOperationDetails(null);
    setSelectedOperation(operation);
    fetchOperationDetails(operation.id);
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'success':
        return <Label status="success">Success</Label>;
      case 'failed':
        return <Label status="danger">Failed</Label>;
      case 'stopped':
        return <Label status="warning">Stopped</Label>;
      default:
        return <Label color="grey">Unknown</Label>;
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '-';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  };

  const filteredOperations = operations.filter(op => {
    if (op.status === 'running') return false;
    if (filter === 'all') return true;
    return op.status === filter;
  });

  const renderOperationDetails = () => {
    if (!selectedOperation) {
      return null;
    }

    const configName = selectedOperation.configFile;

    return (
      <Card isPlain isCompact className="pf-v6-u-mt-sm" style={{ minWidth: 0 }}>
        <CardBody>
          <Title headingLevel="h4" className="pf-v6-u-mb-md">
            <SearchIcon className="pf-v6-u-mr-sm" /> Operation Details
          </Title>

          <DescriptionList isCompact>
            <DescriptionListGroup>
              <DescriptionListTerm>Name</DescriptionListTerm>
              <DescriptionListDescription>{selectedOperation.name}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Status</DescriptionListTerm>
              <DescriptionListDescription>{getStatusLabel(selectedOperation.status)}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Started</DescriptionListTerm>
              <DescriptionListDescription>{new Date(selectedOperation.startedAt).toLocaleString()}</DescriptionListDescription>
            </DescriptionListGroup>
            {selectedOperation.completedAt && (
              <DescriptionListGroup>
                <DescriptionListTerm>
                  {selectedOperation.status === 'failed' ? 'Failed At' : selectedOperation.status === 'stopped' ? 'Stopped At' : 'Completed'}
                </DescriptionListTerm>
                <DescriptionListDescription>{new Date(selectedOperation.completedAt).toLocaleString()}</DescriptionListDescription>
              </DescriptionListGroup>
            )}
            <DescriptionListGroup>
              <DescriptionListTerm>Duration</DescriptionListTerm>
              <DescriptionListDescription>{formatDuration(selectedOperation.duration)}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Config File</DescriptionListTerm>
              <DescriptionListDescription>
                <Button
                  variant="link"
                  isInline
                  component="a"
                  href={`/api/config/download/${encodeURIComponent(configName)}`}
                  download={configName}
                >
                  {configName}
                </Button>
              </DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>

          {selectedOperation.errorMessage && selectedOperation.status !== 'stopped' && (
            <Alert
              variant="danger"
              isInline
              title="Error"
              className="pf-v6-u-mt-md"
            >
              {selectedOperation.errorMessage}
            </Alert>
          )}

          {operationDetails && (
            <div className="pf-v6-u-mt-md">
              <Title headingLevel="h4" className="pf-v6-u-mb-sm">
                Operation Statistics
              </Title>
              <DescriptionList isCompact>
                <DescriptionListGroup>
                  <DescriptionListTerm>Images Mirrored</DescriptionListTerm>
                  <DescriptionListDescription>{operationDetails.imagesMirrored || 0}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>Operators Mirrored</DescriptionListTerm>
                  <DescriptionListDescription>{operationDetails.operatorsMirrored || 0}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>Total Size</DescriptionListTerm>
                  <DescriptionListDescription>{formatFileSize(operationDetails.totalSize)}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>Platform Images</DescriptionListTerm>
                  <DescriptionListDescription>{operationDetails.platformImages || 0}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>Additional Images</DescriptionListTerm>
                  <DescriptionListDescription>{operationDetails.additionalImages || 0}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>Helm Charts</DescriptionListTerm>
                  <DescriptionListDescription>{operationDetails.helmCharts || 0}</DescriptionListDescription>
                </DescriptionListGroup>
              </DescriptionList>
            </div>
          )}

          <div className="pf-v6-u-mt-lg">
            <Title headingLevel="h4" className="pf-v6-u-mb-sm">
              <ListIcon className="pf-v6-u-mr-sm" /> Log Output
            </Title>
            <div ref={logRef} style={{ maxHeight: '320px', overflow: 'auto' }}>
              <CodeBlock>
                <CodeBlockCode>{liveLog || 'No log output available...'}</CodeBlockCode>
              </CodeBlock>
            </div>
          </div>

          <div className="pf-v6-u-mt-md" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              icon={<AngleUpIcon />}
              onClick={() => scrollToSelectedOperation('smooth')}
            >
              Back to top
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  };

  const exportHistory = () => {
    const csvContent = [
      ['Operation Name', 'Status', 'Started', 'Duration', 'Config File', 'Error Message'],
      ...filteredOperations.map(op => [
        op.name,
        op.status,
        new Date(op.startedAt).toLocaleString(),
        formatDuration(op.duration),
        op.configFile,
        op.errorMessage || '',
      ]),
    ].map(row => row.map(field => `"${field}"`).join(',')).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mirror-history-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <PageSection>
        <EmptyState>
          <Spinner size="xl" />
          <EmptyStateBody>Loading history...</EmptyStateBody>
        </EmptyState>
      </PageSection>
    );
  }

  return (
    <PageSection>
      <Card>
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h2">
              <HistoryIcon className="pf-v6-u-mr-sm" />
              Operation History
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          <p>View detailed history of all mirror operations.</p>
        </CardBody>
      </Card>

      <Card className="pf-v6-u-mt-lg" style={{ minWidth: 0 }}>
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h3">
              <ListIcon className="pf-v6-u-mr-sm" />
              Operations
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          <Toolbar>
            <ToolbarContent>
              <ToolbarItem>
                <Select
                  isOpen={filterSelectOpen}
                  selected={filter}
                  onSelect={(_e, val) => {
                    setFilter(val as string);
                    setFilterSelectOpen(false);
                  }}
                  onOpenChange={(open) => setFilterSelectOpen(open)}
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setFilterSelectOpen(prev => !prev)}
                      isExpanded={filterSelectOpen}
                      aria-label="Filter operations"
                    >
                      {{ all: 'All Operations', success: 'Successful', failed: 'Failed', stopped: 'Stopped' }[filter] || 'All Operations'}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    <SelectOption value="all">All Operations</SelectOption>
                    <SelectOption value="success">Successful</SelectOption>
                    <SelectOption value="failed">Failed</SelectOption>
                    <SelectOption value="stopped">Stopped</SelectOption>
                  </SelectList>
                </Select>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="secondary" icon={<DownloadIcon />} onClick={exportHistory}>
                  Export CSV
                </Button>
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        </CardBody>
        <CardBody className="pf-v6-u-p-0">
          {filteredOperations.length === 0 ? (
            <EmptyState>
              <SearchIcon />
              <EmptyStateBody>No operations found.</EmptyStateBody>
            </EmptyState>
          ) : (
            <Table aria-label="Operations list" variant="compact" borders={false}>
              <Thead>
                <Tr>
                  <Th>Operation</Th>
                  <Th>Config</Th>
                  <Th>Status</Th>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                </Tr>
              </Thead>
              <Tbody>
                {filteredOperations.map((op) => {
                  const isSelected = selectedOperation?.id === op.id;

                  return (
                    <Fragment key={op.id}>
                      <Tr
                        isClickable
                        onRowClick={() => (
                          isSelected
                            ? clearSelectedOperation()
                            : handleOperationSelect(op)
                        )}
                      >
                        <Td dataLabel="Operation">
                          <div
                            ref={(element) => {
                              operationRowRefs.current[op.id] = element;
                            }}
                            style={{
                              scrollMarginTop: '1rem',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 'var(--pf-t--global--spacer--xs)',
                            }}
                          >
                            <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                              {isSelected ? <AngleDownIcon /> : <AngleRightIcon />}
                            </span>
                            {op.name}
                          </div>
                        </Td>
                        <Td dataLabel="Config">
                          <Button
                            variant="link"
                            isInline
                            component="a"
                            href={`/api/config/download/${encodeURIComponent(op.configFile)}`}
                            download={op.configFile}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {op.configFile}
                          </Button>
                        </Td>
                        <Td dataLabel="Status">
                          {getStatusLabel(op.status)}
                        </Td>
                        <Td dataLabel="Started">
                          {new Date(op.startedAt).toLocaleString()}
                        </Td>
                        <Td dataLabel="Duration">
                          <OutlinedClockIcon /> {formatDuration(op.duration)}
                        </Td>
                      </Tr>
                      {isSelected && (
                        <Tr>
                          <Td colSpan={5}>
                            {renderOperationDetails()}
                          </Td>
                        </Tr>
                      )}
                    </Fragment>
                  );
                })}
              </Tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </PageSection>
  );
};

export default History;
