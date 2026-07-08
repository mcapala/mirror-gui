import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  ActionGroup,
  Alert,
  Button,
  Checkbox,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Spinner,
  Switch,
  TextArea,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { PlusCircleIcon } from '@patternfly/react-icons';
import { useAlerts } from '../AlertContext';

interface RedactedHub {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  hasCaBundle: boolean;
  insecureSkipVerify: boolean;
  clusters: string[];
}

interface TestResult {
  status: 'ok' | 'failed';
  kind?: string;
  error?: string;
}

interface HubForm {
  name: string;
  url: string;
  token: string;
  caBundle: string;
  insecureSkipVerify: boolean;
}

const emptyForm: HubForm = {
  name: '',
  url: '',
  token: '',
  caBundle: '',
  insecureSkipVerify: false,
};

const AcmHubsSettings: React.FC = () => {
  const { addSuccessAlert, addDangerAlert } = useAlerts();
  const [hubs, setHubs] = useState<RedactedHub[]>([]);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>(
    {},
  );
  const [testingId, setTestingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingHasToken, setEditingHasToken] = useState(false);
  const [editingHasCaBundle, setEditingHasCaBundle] = useState(false);
  const [clearCaBundle, setClearCaBundle] = useState(false);
  const [form, setForm] = useState<HubForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RedactedHub | null>(null);
  const [pickerHub, setPickerHub] = useState<RedactedHub | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerTruncated, setPickerTruncated] = useState(false);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pickerSaving, setPickerSaving] = useState(false);

  const loadHubs = useCallback(async () => {
    try {
      const response = await axios.get('/api/acm/hubs');
      setHubs(response.data.hubs || []);
    } catch (error) {
      const detail = axios.isAxiosError(error)
        ? error.response?.data?.error
        : undefined;
      addDangerAlert(
        detail
          ? `Failed to load ACM hubs: ${detail}`
          : 'Failed to load ACM hubs',
      );
    }
  }, [addDangerAlert]);

  useEffect(() => {
    loadHubs();
  }, [loadHubs]);

  const openAdd = () => {
    setEditingId(null);
    setEditingHasToken(false);
    setEditingHasCaBundle(false);
    setClearCaBundle(false);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (hub: RedactedHub) => {
    setEditingId(hub.id);
    setEditingHasToken(hub.hasToken);
    setEditingHasCaBundle(hub.hasCaBundle);
    setClearCaBundle(false);
    setForm({
      name: hub.name,
      url: hub.url,
      token: '',
      caBundle: '',
      insecureSkipVerify: hub.insecureSkipVerify,
    });
    setModalOpen(true);
  };

  const saveHub = async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        url: form.url,
        insecureSkipVerify: form.insecureSkipVerify,
      };
      if (form.caBundle) {
        payload.caBundle = form.caBundle;
      } else if (!editingId || clearCaBundle) {
        payload.caBundle = '';
      }
      // omitted caBundle on edit = keep the stored bundle (server contract)
      if (form.token) {
        payload.token = form.token;
      }
      if (editingId) {
        await axios.put(`/api/acm/hubs/${editingId}`, payload);
        addSuccessAlert(`Hub "${form.name}" updated`);
      } else {
        await axios.post('/api/acm/hubs', payload);
        addSuccessAlert(`Hub "${form.name}" added`);
      }
      setModalOpen(false);
      await loadHubs();
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      addDangerAlert(`Failed to save hub: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteHub = async (hub: RedactedHub) => {
    try {
      await axios.delete(`/api/acm/hubs/${hub.id}`);
      addSuccessAlert(`Hub "${hub.name}" removed`);
      await loadHubs();
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      addDangerAlert(`Failed to delete hub "${hub.name}": ${message}`);
    }
  };

  const confirmDeleteHub = async () => {
    if (!deleteTarget) return;
    await deleteHub(deleteTarget);
    setDeleteTarget(null);
  };

  const testHub = async (hub: RedactedHub) => {
    setTestingId(hub.id);
    try {
      const response = await axios.post(`/api/acm/hubs/${hub.id}/test`);
      setTestResults(prev => ({ ...prev, [hub.id]: response.data }));
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      setTestResults(prev => ({
        ...prev,
        [hub.id]: { status: 'failed', error: message },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const openPicker = async (hub: RedactedHub) => {
    setPickerHub(hub);
    setPickerError(null);
    setPickerTruncated(false);
    setDiscovered([]);
    setChecked(new Set(hub.clusters));
    setPickerLoading(true);
    try {
      const response = await axios.post(
        `/api/acm/hubs/${hub.id}/clusters/discover`,
      );
      if (response.data.status === 'ok') {
        setDiscovered(response.data.clusters ?? []);
        setPickerTruncated(Boolean(response.data.truncated));
      } else {
        setPickerError(
          `${response.data.kind ?? 'failed'}: ${response.data.error ?? 'cluster discovery failed'}`,
        );
      }
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      setPickerError(message);
    } finally {
      setPickerLoading(false);
    }
  };

  const savePicker = async () => {
    if (!pickerHub) return;
    setPickerSaving(true);
    try {
      await axios.put(`/api/acm/hubs/${pickerHub.id}`, {
        name: pickerHub.name,
        url: pickerHub.url,
        insecureSkipVerify: pickerHub.insecureSkipVerify,
        clusters: [...checked].sort(),
      });
      addSuccessAlert(`Cluster selection for "${pickerHub.name}" saved`);
      setPickerHub(null);
      await loadHubs();
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : String(error);
      addDangerAlert(`Failed to save cluster selection: ${message}`);
    } finally {
      setPickerSaving(false);
    }
  };

  const toggleCluster = (name: string, isChecked: boolean) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (isChecked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  };

  const tlsMode = (hub: RedactedHub): string => {
    if (hub.insecureSkipVerify) return 'skip verification';
    if (hub.hasCaBundle) return 'custom CA';
    return 'verified';
  };

  return (
    <div className="pf-v6-u-py-lg">
      <Title headingLevel="h3" className="pf-v6-u-mb-md">
        ACM Hubs
      </Title>
      <p className="pf-v6-u-mb-md">
        Configure Advanced Cluster Management hubs. The Search API of each hub
        is queried to build the fleet operator-versions snapshot.
      </p>

      {hubs.length === 0 ? (
        <EmptyState titleText="No ACM hubs configured" headingLevel="h4">
          <EmptyStateBody>
            Add a hub to enable the Fleet Operators dashboard.
          </EmptyStateBody>
        </EmptyState>
      ) : (
        <Table aria-label="ACM hubs" variant="compact">
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>URL</Th>
              <Th>TLS</Th>
              <Th>Token</Th>
              <Th>Clusters</Th>
              <Th>Last test</Th>
              <Th screenReaderText="Actions" />
            </Tr>
          </Thead>
          <Tbody>
            {hubs.map(hub => {
              const test = testResults[hub.id];
              return (
                <Tr key={hub.id}>
                  <Td dataLabel="Name">{hub.name}</Td>
                  <Td dataLabel="URL">{hub.url}</Td>
                  <Td dataLabel="TLS">
                    <Label
                      color={hub.insecureSkipVerify ? 'yellow' : 'green'}
                      isCompact
                    >
                      {tlsMode(hub)}
                    </Label>
                  </Td>
                  <Td dataLabel="Token">
                    {hub.hasToken ? 'stored' : 'missing'}
                  </Td>
                  <Td dataLabel="Clusters">
                    {hub.clusters.length > 0 ? (
                      `${hub.clusters.length} selected`
                    ) : (
                      <Label color="yellow" isCompact>
                        none — inactive
                      </Label>
                    )}
                  </Td>
                  <Td dataLabel="Last test">
                    {test ? (
                      <Label
                        color={test.status === 'ok' ? 'green' : 'red'}
                        isCompact
                      >
                        {test.status === 'ok'
                          ? 'ok'
                          : test.error
                            ? `${test.kind ?? 'failed'}: ${test.error}`
                            : (test.kind ?? 'failed')}
                      </Label>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td dataLabel="Actions" modifier="fitContent">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => testHub(hub)}
                      isLoading={testingId === hub.id}
                      isDisabled={testingId !== null}
                      className="pf-v6-u-mr-sm"
                    >
                      Test
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openPicker(hub)}
                      className="pf-v6-u-mr-sm"
                    >
                      Clusters
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openEdit(hub)}
                      className="pf-v6-u-mr-sm"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setDeleteTarget(hub)}
                    >
                      Delete
                    </Button>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      )}

      <ActionGroup className="pf-v6-u-mt-md">
        <Button variant="primary" icon={<PlusCircleIcon />} onClick={openAdd}>
          Add Hub
        </Button>
      </ActionGroup>

      <Modal
        variant={ModalVariant.medium}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        aria-label="ACM hub form"
      >
        <ModalHeader title={editingId ? 'Edit ACM Hub' : 'Add ACM Hub'} />
        <ModalBody>
          <Form>
            <FormGroup label="Name" isRequired fieldId="acm-hub-name">
              <TextInput
                id="acm-hub-name"
                isRequired
                value={form.name}
                onChange={(_e, value) => setForm({ ...form, name: value })}
              />
            </FormGroup>
            <FormGroup label="Search API URL" isRequired fieldId="acm-hub-url">
              <TextInput
                id="acm-hub-url"
                isRequired
                placeholder="https://search-search-api-open-cluster-management.apps.<hub-domain>"
                value={form.url}
                onChange={(_e, value) => setForm({ ...form, url: value })}
              />
              <HelperText>
                <HelperTextItem>Must start with https://</HelperTextItem>
              </HelperText>
            </FormGroup>
            <FormGroup
              label="API token"
              isRequired={!editingId || !editingHasToken}
              fieldId="acm-hub-token"
            >
              <TextInput
                id="acm-hub-token"
                type="password"
                placeholder={
                  editingId && editingHasToken
                    ? 'token stored — leave empty to keep'
                    : ''
                }
                value={form.token}
                onChange={(_e, value) => setForm({ ...form, token: value })}
              />
              <HelperText>
                <HelperTextItem>
                  An OpenShift API token with access to the Search API. A
                  ServiceAccount token with search-only RBAC is recommended so
                  it does not expire.
                </HelperTextItem>
              </HelperText>
            </FormGroup>
            <FormGroup label="CA bundle (PEM)" fieldId="acm-hub-ca">
              <TextArea
                id="acm-hub-ca"
                rows={4}
                placeholder={
                  editingId && editingHasCaBundle
                    ? 'CA bundle stored — paste to replace, leave empty to keep'
                    : '-----BEGIN CERTIFICATE-----'
                }
                value={form.caBundle}
                onChange={(_e, value) => setForm({ ...form, caBundle: value })}
              />
              {editingId && editingHasCaBundle && !form.caBundle && (
                <Checkbox
                  id="acm-hub-clear-ca"
                  className="pf-v6-u-mt-sm"
                  label="Clear the stored CA bundle"
                  isChecked={clearCaBundle}
                  onChange={(_e, checked) => setClearCaBundle(checked)}
                />
              )}
            </FormGroup>
            <FormGroup fieldId="acm-hub-skip-tls">
              <Switch
                id="acm-hub-skip-tls"
                label="Skip TLS verification (insecure — prefer a CA bundle)"
                isChecked={form.insecureSkipVerify}
                onChange={(_e, checked) =>
                  setForm({ ...form, insecureSkipVerify: checked })
                }
              />
            </FormGroup>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="primary"
            onClick={saveHub}
            isLoading={saving}
            isDisabled={
              saving ||
              !form.name ||
              !form.url ||
              ((!editingId || !editingHasToken) && !form.token)
            }
          >
            Save
          </Button>
          <Button variant="link" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.small}
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        aria-label="Delete confirmation"
      >
        <ModalHeader title="Delete ACM Hub" />
        <ModalBody>
          <p>
            Are you sure you want to delete{' '}
            <span style={{ fontWeight: 600 }}>
              &quot;{deleteTarget?.name}&quot;
            </span>
            ? This action cannot be undone.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={confirmDeleteHub}>
            Delete
          </Button>
          <Button variant="link" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.medium}
        isOpen={pickerHub !== null}
        onClose={() => setPickerHub(null)}
        aria-label="Cluster selection"
      >
        <ModalHeader title="Select Clusters" />
        <ModalBody>
          <p className="pf-v6-u-mb-md">
            Only the selected clusters are included in the fleet snapshot. A
            hub with no selection is inactive.
          </p>
          {pickerLoading ? (
            <Spinner aria-label="Discovering clusters" />
          ) : (
            <>
              {pickerError && (
                <Alert
                  variant="danger"
                  isInline
                  title="Cluster discovery failed"
                  className="pf-v6-u-mb-md"
                >
                  {pickerError}
                </Alert>
              )}
              {pickerTruncated && (
                <Alert
                  variant="warning"
                  isInline
                  title="Cluster list hit the search limit — it may be incomplete"
                  className="pf-v6-u-mb-md"
                />
              )}
              <ActionGroup className="pf-v6-u-mb-sm">
                <Button
                  variant="link"
                  isInline
                  className="pf-v6-u-mr-md"
                  onClick={() =>
                    setChecked(
                      new Set([...discovered, ...(pickerHub?.clusters ?? [])]),
                    )
                  }
                >
                  Select all
                </Button>
                <Button
                  variant="link"
                  isInline
                  onClick={() => setChecked(new Set())}
                >
                  Clear
                </Button>
              </ActionGroup>
              {[
                ...discovered,
                ...(pickerHub?.clusters ?? []).filter(
                  c => !discovered.includes(c),
                ),
              ].map(name => (
                <Checkbox
                  key={name}
                  id={`cluster-pick-${name}`}
                  label={
                    discovered.includes(name)
                      ? name
                      : `${name} (not found on hub)`
                  }
                  isChecked={checked.has(name)}
                  onChange={(_e, isChecked) => toggleCluster(name, isChecked)}
                />
              ))}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="primary"
            onClick={savePicker}
            isLoading={pickerSaving}
            isDisabled={pickerSaving || pickerLoading}
          >
            Save
          </Button>
          <Button variant="link" onClick={() => setPickerHub(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
};

export default AcmHubsSettings;
