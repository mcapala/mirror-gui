import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  ActionGroup,
  Button,
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
  const [form, setForm] = useState<HubForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const loadHubs = useCallback(async () => {
    try {
      const response = await axios.get('/api/acm/hubs');
      setHubs(response.data.hubs || []);
    } catch {
      addDangerAlert('Failed to load ACM hubs');
    }
  }, [addDangerAlert]);

  useEffect(() => {
    loadHubs();
  }, [loadHubs]);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (hub: RedactedHub) => {
    setEditingId(hub.id);
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
        caBundle: form.caBundle || undefined,
        insecureSkipVerify: form.insecureSkipVerify,
      };
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
    } catch {
      addDangerAlert(`Failed to delete hub "${hub.name}"`);
    }
  };

  const testHub = async (hub: RedactedHub) => {
    setTestingId(hub.id);
    try {
      const response = await axios.post(`/api/acm/hubs/${hub.id}/test`);
      setTestResults(prev => ({ ...prev, [hub.id]: response.data }));
    } catch {
      setTestResults(prev => ({
        ...prev,
        [hub.id]: { status: 'failed', error: 'request failed' },
      }));
    } finally {
      setTestingId(null);
    }
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
                  <Td dataLabel="Last test">
                    {test ? (
                      <Label
                        color={test.status === 'ok' ? 'green' : 'red'}
                        isCompact
                      >
                        {test.status === 'ok'
                          ? 'ok'
                          : `${test.kind ?? 'failed'}: ${test.error ?? ''}`}
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
                      onClick={() => openEdit(hub)}
                      className="pf-v6-u-mr-sm"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => deleteHub(hub)}
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
              isRequired={!editingId}
              fieldId="acm-hub-token"
            >
              <TextInput
                id="acm-hub-token"
                type="password"
                placeholder={
                  editingId ? 'token stored — leave empty to keep' : ''
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
                  editingId
                    ? 'leave empty to keep / clear the stored CA bundle'
                    : '-----BEGIN CERTIFICATE-----'
                }
                value={form.caBundle}
                onChange={(_e, value) => setForm({ ...form, caBundle: value })}
              />
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
              saving || !form.name || !form.url || (!editingId && !form.token)
            }
          >
            Save
          </Button>
          <Button variant="link" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
};

export default AcmHubsSettings;
