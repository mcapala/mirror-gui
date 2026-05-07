import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import {
  Card,
  CardBody,
  CardTitle,
  CardHeader,
  FormGroup,
  Select,
  SelectOption,
  SelectList,
  MenuToggle,
  InputGroup,
  InputGroupItem,
  TextInput,
  Button,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  CodeBlock,
  CodeBlockCode,
  Spinner,
  Title,
  Flex,
  FlexItem,
  Popover,
  EmptyState,
  EmptyStateBody,
  Alert,
  Tooltip,
  Dropdown,
  DropdownItem,
  DropdownList,
  Divider,
} from '@patternfly/react-core';
import {
  SyncAltIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
  ListIcon,
  CopyIcon,
  InfoCircleIcon,
  OutlinedClockIcon,
  EllipsisVIcon,
  AngleUpIcon,
} from '@patternfly/react-icons';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { useAlerts } from '../AlertContext';

interface ConfigFile {
  name: string;
  size: string;
}

interface Operation {
  id: string;
  name: string;
  configFile: string;
  status: 'running' | 'success' | 'failed' | 'stopped';
  startedAt: string;
  completedAt?: string;
  duration?: number;
  mirrorDestination?: string;
  errorMessage?: string;
}

const MirrorOperations: React.FC = () => {
  const { addSuccessAlert, addDangerAlert, addWarningAlert, addInfoAlert } = useAlerts();

  const [operations, setOperations] = useState<Operation[]>([]);
  const [selectedConfig, setSelectedConfig] = useState('');
  const [configSelectOpen, setConfigSelectOpen] = useState(false);
  const [availableConfigs, setAvailableConfigs] = useState<ConfigFile[]>([]);
  const [runningOperation, setRunningOperation] = useState<Operation | null>(null);
  const [logs, setLogs] = useState('');
  const [logStream, setLogStream] = useState<EventSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteFilename, setDeleteFilename] = useState('');
  const [deleteOperationId, setDeleteOperationId] = useState<string | null>(null);
  const [mirrorDestinationSubdir, setMirrorDestinationSubdir] = useState('');
  const [showStopModal, setShowStopModal] = useState(false);
  const [stopOperationId, setStopOperationId] = useState<string | null>(null);
  const [kebabOpen, setKebabOpen] = useState<Record<string, boolean>>({});
  const [hostDataDir, setHostDataDir] = useState('');
  const [now, setNow] = useState(Date.now());

  const operationsRef = useRef<Operation[]>([]);
  const notifiedOperationsRef = useRef(new Set<string>());
  const logStreamOperationIdRef = useRef<string | null>(null);
  const lastRunningOperationIdRef = useRef<string | null>(null);

  const stopLogStream = useCallback(() => {
    if (logStream) {
      logStream.close();
      setLogStream(null);
    }
    logStreamOperationIdRef.current = null;
  }, [logStream]);

  const fetchLogs = useCallback(async (operationId: string) => {
    try {
      const response = await axios.get(`/api/operations/${operationId}/logs`);
      setLogs(response.data.logs || 'No logs available for this operation');
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      console.error('Error fetching logs:', error);
      setLogs(`Error loading logs: ${err.response?.data?.message || err.message}`);
    }
  }, []);

  const handleOperationCompleted = useCallback((op: Operation) => {
    if (!op?.id) return;

    setTimeout(() => fetchLogs(op.id), 500);

    const isTerminalStatus = op.status === 'success' || op.status === 'failed' || op.status === 'stopped';
    if (!isTerminalStatus) return;

    if (!notifiedOperationsRef.current.has(op.id)) {
      notifiedOperationsRef.current.add(op.id);

      if (op.status === 'success') {
        addSuccessAlert('Mirror Operation Completed!');
      } else if (op.status === 'failed') {
        addDangerAlert('Mirror Operation Failed');
      } else if (op.status === 'stopped') {
        addWarningAlert('Mirror Operation Stopped');
      }
    }
  }, [addSuccessAlert, addDangerAlert, addWarningAlert, addInfoAlert, fetchLogs]);

  const startLogStream = useCallback((operationId: string) => {
    if (logStream) {
      logStream.close();
    }

    const eventSource = new EventSource(`/api/operations/${operationId}/logstream`);
    setLogStream(eventSource);
    logStreamOperationIdRef.current = operationId;

    eventSource.onmessage = (event) => {
      setLogs(prevLogs => prevLogs + event.data);
    };

    eventSource.addEventListener('done', (event) => {
      let payload: { status?: string } | null = null;
      try {
        payload = JSON.parse((event as MessageEvent).data);
      } catch { /* ignore parse errors */ }

      const status = payload?.status || 'unknown';
      const completedOp = operationsRef.current.find(op => op.id === operationId) || {
        id: operationId,
        status: status as Operation['status'],
        name: '',
        configFile: '',
        startedAt: '',
      };
      handleOperationCompleted(completedOp);
      lastRunningOperationIdRef.current = null;
      stopLogStream();
    });

    eventSource.onerror = () => {
      eventSource.close();
      setLogStream(null);
      logStreamOperationIdRef.current = null;
    };

    return eventSource;
  }, [logStream, handleOperationCompleted, stopLogStream]);

  const fetchConfigurations = useCallback(async () => {
    try {
      const response = await axios.get('/api/config/list');
      setAvailableConfigs(response.data);
    } catch (error) {
      console.error('Error fetching configurations:', error);
    }
  }, []);

  const fetchOperations = useCallback(async () => {
    try {
      const response = await axios.get('/api/operations');
      const previousOps = operationsRef.current;
      setOperations(response.data);

      response.data.forEach((op: Operation) => {
        const prevOp = previousOps.find(p => p.id === op.id);
        const justCompleted = prevOp && prevOp.status === 'running' &&
          (op.status === 'success' || op.status === 'failed' || op.status === 'stopped');

        if (justCompleted) {
          handleOperationCompleted(op);
        }
      });

      const running = response.data.find((op: Operation) => op.status === 'running');
      if (running) {
        lastRunningOperationIdRef.current = running.id;
      }

      if (!running && lastRunningOperationIdRef.current) {
        const lastOpId = lastRunningOperationIdRef.current;
        const completedOp = response.data.find((op: Operation) => op.id === lastOpId);
        if (completedOp && (completedOp.status === 'success' || completedOp.status === 'failed' || completedOp.status === 'stopped')) {
          handleOperationCompleted(completedOp);
          if (logStreamOperationIdRef.current === completedOp.id) {
            stopLogStream();
          }
          lastRunningOperationIdRef.current = null;
        }
      }
      setRunningOperation(running || null);

      if (running) {
        fetchLogs(running.id);
      }
    } catch (error) {
      console.error('Error fetching operations:', error);
    }
  }, [handleOperationCompleted, stopLogStream, fetchLogs]);

  useEffect(() => {
    fetchOperations();
    fetchConfigurations();
    axios.get('/api/system/info').then(res => setHostDataDir(res.data.hostDataDir || '')).catch(() => {});
    const interval = setInterval(fetchOperations, 5000);
    return () => clearInterval(interval);
  }, [fetchOperations, fetchConfigurations]);

  useEffect(() => {
    operationsRef.current = operations;
  }, [operations]);

  useEffect(() => {
    if (runningOperation) {
      lastRunningOperationIdRef.current = runningOperation.id;
      if (logStreamOperationIdRef.current !== runningOperation.id) {
        startLogStream(runningOperation.id);
      }
    }
  }, [runningOperation, startLogStream]);

  useEffect(() => () => {
    if (logStream) {
      logStream.close();
    }
  }, [logStream]);

  useEffect(() => {
    if (showLogs && logs) {
      const logContainer = document.getElementById('log-container');
      if (logContainer) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    }
  }, [logs, showLogs]);

  useEffect(() => {
    const hasRunning = operations.some((op) => op.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [operations]);

  const getElapsedSeconds = (startedAt: string) => {
    return Math.floor((now - new Date(startedAt).getTime()) / 1000);
  };

  const startOperation = async () => {
    if (!selectedConfig) {
      addDangerAlert('Please select an ImageSetConfiguration file');
      return;
    }

    try {
      setLoading(true);
      const response = await axios.post('/api/operations/start', {
        configFile: selectedConfig,
        mirrorDestinationSubdir: mirrorDestinationSubdir.trim() || undefined,
      });

      addSuccessAlert('Operation started successfully!');
      setShowLogs(true);
      fetchOperations();
      setMirrorDestinationSubdir('');

      if (response.data.status === 'running') {
        const logInterval = setInterval(async () => {
          try {
            const logResponse = await axios.get(`/api/operations/${response.data.id}/logs`);
            setLogs(logResponse.data.logs || '');
          } catch (error) {
            console.error('Error polling logs:', error);
          }
        }, 2000);

        setTimeout(() => clearInterval(logInterval), 300000);
      }
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      console.error('Error starting operation:', error);
      addDangerAlert(`Failed to start operation: ${err.response?.data?.message || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const deleteConfiguration = (configName: string) => {
    setDeleteFilename(configName);
    setDeleteOperationId(null);
    setShowDeleteModal(true);
  };

  const confirmDeleteConfig = async () => {
    try {
      await axios.delete(`/api/config/delete/${encodeURIComponent(deleteFilename)}`);
      addSuccessAlert(`Configuration "${deleteFilename}" deleted successfully!`);
      fetchConfigurations();

      if (selectedConfig === deleteFilename) {
        setSelectedConfig('');
      }

      setShowDeleteModal(false);
      setDeleteFilename('');
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      console.error('Error deleting configuration:', error);
      addDangerAlert(`Failed to delete configuration: ${err.response?.data?.message || err.message}`);
    }
  };

  const stopOperation = async (operationId: string) => {
    try {
      await axios.post(`/api/operations/${operationId}/stop`);
      fetchOperations();
    } catch (error) {
      console.error('Error stopping operation:', error);
      addDangerAlert('Failed to stop operation');
    }
  };

  const promptStopOperation = (operationId: string) => {
    setStopOperationId(operationId);
    setShowStopModal(true);
  };

  const confirmStopOperation = async () => {
    if (!stopOperationId) return;
    await stopOperation(stopOperationId);
    setShowStopModal(false);
    setStopOperationId(null);
  };

  const promptDeleteOperation = (operationId: string) => {
    setDeleteOperationId(operationId);
    setDeleteFilename('');
    setShowDeleteModal(true);
  };

  const confirmDeleteOperation = async () => {
    if (!deleteOperationId) return;
    try {
      await axios.delete(`/api/operations/${deleteOperationId}`);
      addSuccessAlert('Operation deleted successfully!');
      fetchOperations();
      setShowDeleteModal(false);
      setDeleteOperationId(null);
    } catch (error) {
      console.error('Error deleting operation:', error);
      addDangerAlert('Failed to delete operation');
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'success':
        return <Label status="success">Success</Label>;
      case 'running':
        return <Label color="teal" icon={<Spinner size="sm" />}>Running</Label>;
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

  const scrollToOperations = () => {
    document.getElementById('operation-history-card')?.scrollIntoView({ behavior: 'smooth' });
  };

  const getMirrorFullPath = (mirrorDestination: string) => {
    if (hostDataDir && mirrorDestination.startsWith('/app/data')) {
      return mirrorDestination.replace('/app/data', hostDataDir);
    }
    return mirrorDestination;
  };

  const copyMirrorPath = async (mirrorDestination: string) => {
    const fullPath = getMirrorFullPath(mirrorDestination);

    try {
      await navigator.clipboard.writeText(fullPath);
      addSuccessAlert('Full path copied to clipboard!');
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = fullPath;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        addSuccessAlert('Full path copied to clipboard!');
      } catch {
        addDangerAlert('Failed to copy path');
      }
      document.body.removeChild(textArea);
    }
  };

  const isDeleteConfig = deleteFilename && !deleteOperationId;

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h2">
              <SyncAltIcon /> Mirror Operations
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          Run mirror operations using saved configurations and track their progress.
        </CardBody>
      </Card>

      <Card className="pf-v6-u-mt-lg">
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h3">
              Start New Operation
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          <FormGroup label="ImageSetConfiguration File" fieldId="config-select">
            <InputGroup>
              <InputGroupItem isFill>
                <Select
                  id="config-select"
                  isOpen={configSelectOpen}
                  selected={selectedConfig}
                  onSelect={(_e, val) => {
                    setSelectedConfig(val as string);
                    setConfigSelectOpen(false);
                  }}
                  onOpenChange={(open) => setConfigSelectOpen(open)}
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setConfigSelectOpen(prev => !prev)}
                      isExpanded={configSelectOpen}
                      aria-label="Select ImageSetConfiguration file"
                      style={{ width: '100%' }}
                    >
                      {selectedConfig
                        ? `${selectedConfig} (${availableConfigs.find(c => c.name === selectedConfig)?.size || ''})`
                        : 'Select an ImageSetConfiguration file...'}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    {availableConfigs.map(config => (
                      <SelectOption key={config.name} value={config.name}>
                        {`${config.name} (${config.size})`}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </InputGroupItem>
              {selectedConfig && (
                <InputGroupItem>
                  <Tooltip content="Delete configuration">
                    <Button
                      variant="plain"
                      icon={<TrashIcon />}
                      onClick={() => deleteConfiguration(selectedConfig)}
                      aria-label="Delete configuration"
                    />
                  </Tooltip>
                </InputGroupItem>
              )}
            </InputGroup>
          </FormGroup>

          <Flex alignItems={{ default: 'alignItemsFlexEnd' }} className="pf-v6-u-mt-md">
            <FlexItem>
              <FormGroup
                label={
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 'var(--pf-t--global--spacer--xs)',
                    }}
                  >
                    <span>Mirror Destination Folder</span>
                    <Popover
                      bodyContent="Mirror files are saved to data/mirrors/<folder>. Leave empty for &quot;default&quot;. The folder is created automatically with correct permissions."
                    >
                      <Button
                        variant="plain"
                        aria-label="More info"
                        hasNoPadding
                        type="button"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: 'auto',
                          height: '1.25rem',
                          lineHeight: 1,
                          position: 'relative',
                          top: '1px',
                          color: 'var(--pf-t--global--text--color--regular, #151515)',
                        }}
                      >
                        <InfoCircleIcon style={{ fontSize: '0.875rem' }} />
                      </Button>
                    </Popover>
                  </span>
                }
                fieldId="mirror-subdir"
              >
                <TextInput
                  id="mirror-subdir"
                  value={mirrorDestinationSubdir}
                  onChange={(_event, value) => setMirrorDestinationSubdir(value)}
                  placeholder="default"
                  style={{ width: '250px' }}
                />
              </FormGroup>
            </FlexItem>
            <FlexItem>
              <Button
                variant="primary"
                icon={loading ? <Spinner size="md" /> : <PlayIcon />}
                onClick={startOperation}
                isDisabled={!selectedConfig || loading}
              >
                Start Operation
              </Button>
            </FlexItem>
          </Flex>
        </CardBody>
      </Card>

      <Card className="pf-v6-u-mt-lg" id="operation-history-card">
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h3">
              Operations
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody className="pf-v6-u-p-0">
          {operations.length === 0 ? (
            <EmptyState>
              <EmptyStateBody>No operations found.</EmptyStateBody>
            </EmptyState>
          ) : (
            <Table aria-label="Operation history" variant="compact" borders={false}>
              <Thead>
                <Tr>
                  <Th>Operation</Th>
                  <Th>Config</Th>
                  <Th>Status</Th>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                  <Th screenReaderText="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {operations.map((op) => (
                  <Tr key={op.id}>
                    <Td dataLabel="Operation">
                      {op.name}
                    </Td>
                    <Td dataLabel="Config">
                      {op.configFile}
                    </Td>
                    <Td dataLabel="Status">
                      {getStatusLabel(op.status)}
                    </Td>
                    <Td dataLabel="Started">
                      {new Date(op.startedAt).toLocaleString()}
                    </Td>
                    <Td dataLabel="Duration">
                      <OutlinedClockIcon /> {op.status === 'running'
                        ? formatDuration(getElapsedSeconds(op.startedAt))
                        : formatDuration(op.duration)}
                    </Td>
                    <Td isActionCell>
                      <Dropdown
                        isOpen={!!kebabOpen[op.id]}
                        onOpenChange={(open) => setKebabOpen((prev) => ({ ...prev, [op.id]: open }))}
                        toggle={(toggleRef) => (
                          <MenuToggle
                            ref={toggleRef}
                            variant="plain"
                            onClick={() => setKebabOpen((prev) => ({ ...prev, [op.id]: !prev[op.id] }))}
                            isExpanded={!!kebabOpen[op.id]}
                            icon={<EllipsisVIcon />}
                            aria-label={`Actions for ${op.name}`}
                          />
                        )}
                        shouldFocusToggleOnSelect
                        popperProps={{ position: 'right' }}
                      >
                        <DropdownList>
                          <DropdownItem
                            key={`${op.id}-logs`}
                            icon={<ListIcon />}
                            onClick={() => {
                              setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                              void fetchLogs(op.id);
                              setShowLogs(true);
                              setTimeout(() => {
                                document.getElementById('operation-logs-card')?.scrollIntoView({ behavior: 'smooth' });
                              }, 100);
                            }}
                          >
                            View Logs
                          </DropdownItem>
                          {op.status === 'success' && op.mirrorDestination && (
                            <DropdownItem
                              key={`${op.id}-copy-location`}
                              icon={<CopyIcon />}
                              onClick={() => {
                                setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                                void copyMirrorPath(op.mirrorDestination!);
                              }}
                            >
                              Copy Location
                            </DropdownItem>
                          )}
                          <Divider key={`${op.id}-div`} component="li" />
                          {op.status === 'running' && (
                            <DropdownItem
                              key={`${op.id}-stop`}
                              icon={<StopIcon />}
                              isDanger
                              onClick={() => {
                                setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                                promptStopOperation(op.id);
                              }}
                            >
                              Stop
                            </DropdownItem>
                          )}
                          <DropdownItem
                            key={`${op.id}-delete`}
                            icon={<TrashIcon />}
                            isDanger
                            onClick={() => {
                              setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                              promptDeleteOperation(op.id);
                            }}
                          >
                            Delete
                          </DropdownItem>
                        </DropdownList>
                      </Dropdown>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {showLogs && (
        <Card className="pf-v6-u-mt-lg" id="operation-logs-card">
          <CardHeader>
            <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} alignItems={{ default: 'alignItemsCenter' }}>
              <FlexItem>
                <CardTitle>
                  <Title headingLevel="h4">
                    Operation Logs
                  </Title>
                </CardTitle>
              </FlexItem>
              <FlexItem>
                <Button variant="secondary" icon={<AngleUpIcon />} onClick={scrollToOperations}>
                  Back to Top
                </Button>
              </FlexItem>
            </Flex>
          </CardHeader>
          <CardBody>
            <div id="log-container" style={{ maxHeight: '400px', overflow: 'auto' }}>
              <CodeBlock>
                <CodeBlockCode>{logs || 'No logs available'}</CodeBlockCode>
              </CodeBlock>
            </div>
          </CardBody>
        </Card>
      )}

      <Modal
        variant={ModalVariant.small}
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setDeleteFilename('');
          setDeleteOperationId(null);
        }}
        aria-label="Delete confirmation"
      >
        <ModalHeader title={isDeleteConfig ? 'Delete ImageSetConfiguration File' : 'Delete Operation Record'} />
        <ModalBody>
          {isDeleteConfig ? (
            <>
              <p>
                Are you sure you want to delete <span style={{ fontWeight: 600 }}>&quot;{deleteFilename}&quot;</span>? This file will be permanently removed.
              </p>
              <Alert variant="warning" isInline isPlain title="This action cannot be undone." className="pf-v6-u-mt-md" />
            </>
          ) : (
            <>
              <p>
                Are you sure you want to delete the record for operation <span style={{ fontWeight: 600 }}>&quot;{deleteOperationId}&quot;</span>? The operation logs will be permanently removed.
              </p>
              <Alert variant="warning" isInline isPlain title="This action cannot be undone." className="pf-v6-u-mt-md" />
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={isDeleteConfig ? confirmDeleteConfig : confirmDeleteOperation}
          >
            Delete
          </Button>
          <Button
            variant="link"
            onClick={() => {
              setShowDeleteModal(false);
              setDeleteFilename('');
              setDeleteOperationId(null);
            }}
          >
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.small}
        isOpen={showStopModal}
        onClose={() => {
          setShowStopModal(false);
          setStopOperationId(null);
        }}
        aria-label="Stop confirmation"
      >
        <ModalHeader title="Stop Operation" />
        <ModalBody>
          <p>
            Are you sure you want to stop the running operation <span style={{ fontWeight: 600 }}>&quot;{stopOperationId}&quot;</span>?
          </p>
          <Alert variant="custom" isInline isPlain customIcon={<InfoCircleIcon />} title="You can start a new operation with the same configuration." className="pf-v6-u-mt-md" />
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={confirmStopOperation}>
            Stop Operation
          </Button>
          <Button
            variant="link"
            onClick={() => {
              setShowStopModal(false);
              setStopOperationId(null);
            }}
          >
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
};

export default MirrorOperations;
