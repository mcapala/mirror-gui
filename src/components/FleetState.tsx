import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Tab,
  TabTitleIcon,
  TabTitleText,
  Tabs,
  Title,
} from '@patternfly/react-core';
import { ClusterIcon, DatabaseIcon } from '@patternfly/react-icons';
import FleetOperators from './FleetOperators';
import RegistryContent from './registryContent/RegistryContent';

const FleetState: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<string | number>(
    searchParams.get('tab') || 'fleet-operators',
  );

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab) setActiveTab(tab);
  }, [searchParams]);

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h2">
              <ClusterIcon /> Fleet State
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          Review what is currently deployed and mirrored across the fleet.
        </CardBody>
      </Card>

      <Card className="pf-v6-u-mt-lg">
        <CardBody>
          <Tabs
            activeKey={activeTab}
            onSelect={(_e, key) => setActiveTab(key)}
            isFilled
          >
            <Tab
              eventKey="fleet-operators"
              title={
                <>
                  <TabTitleIcon><ClusterIcon /></TabTitleIcon>
                  <TabTitleText>Fleet Operators</TabTitleText>
                </>
              }
            >
              <FleetOperators />
            </Tab>
            <Tab
              eventKey="registry-content"
              title={
                <>
                  <TabTitleIcon><DatabaseIcon /></TabTitleIcon>
                  <TabTitleText>Registry Content</TabTitleText>
                </>
              }
            >
              <RegistryContent />
            </Tab>
          </Tabs>
        </CardBody>
      </Card>
    </div>
  );
};

export default FleetState;
