import { Template, Match } from 'aws-cdk-lib/assertions';
import { COMMON_TAGS } from '../lib/config';
import { buildApp } from './helpers';

describe('ApplicationStack', () => {
  const { application } = buildApp();
  const template = Template.fromStack(application);

  function taskDefinitionWithContainer(containerName: string): any {
    const taskDefinitions = Object.values(
      template.findResources('AWS::ECS::TaskDefinition'),
    );
    const taskDefinition = taskDefinitions.find((resource: any) =>
      resource.Properties.ContainerDefinitions.some(
        (container: any) => container.Name === containerName,
      ),
    );

    expect(taskDefinition).toBeDefined();
    return taskDefinition;
  }

  function roleLogicalId(roleArn: any): string {
    expect(roleArn).toEqual({
      'Fn::GetAtt': [expect.any(String), 'Arn'],
    });
    return roleArn['Fn::GetAtt'][0];
  }

  function policyActionsForRole(roleId: string): string[] {
    return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (resource: any) => {
        const isAttachedToRole = resource.Properties.Roles.some(
          (role: any) => role.Ref === roleId,
        );
        if (!isAttachedToRole) {
          return [];
        }

        return resource.Properties.PolicyDocument.Statement.flatMap(
          (statement: any) =>
            Array.isArray(statement.Action)
              ? statement.Action
              : [statement.Action],
        );
      },
    );
  }

  test('defines 3 task definitions', () => {
    template.resourceCountIs('AWS::ECS::TaskDefinition', 3);
  });

  test('collector task has 2 containers (otel-collector + post-processor)', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'otel-collector' }),
        Match.objectLike({ Name: 'post-processor' }),
      ]),
    });
  });

  test('batch-processor container is non-essential', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'batch-processor', Essential: false }),
      ]),
    });
  });

  test('DB 시크릿 조회 권한은 DB_CREDS 주입 태스크의 execution role에만 부여한다', () => {
    const collectorTask = taskDefinitionWithContainer('post-processor');
    const dashboardTask = taskDefinitionWithContainer('api-server');
    const clickhouseTask = taskDefinitionWithContainer('clickhouse');

    const executionRoleIds = [
      collectorTask.Properties.ExecutionRoleArn,
      dashboardTask.Properties.ExecutionRoleArn,
      clickhouseTask.Properties.ExecutionRoleArn,
    ].map(roleLogicalId);
    expect(new Set(executionRoleIds).size).toBe(3);

    const secretReadActions = [
      'secretsmanager:GetSecretValue',
      'secretsmanager:DescribeSecret',
    ];
    for (const roleId of executionRoleIds.slice(0, 2)) {
      expect(policyActionsForRole(roleId)).toEqual(
        expect.arrayContaining(secretReadActions),
      );
    }
    for (const action of secretReadActions) {
      expect(policyActionsForRole(executionRoleIds[2])).not.toContain(action);
    }

    for (const task of [collectorTask, dashboardTask, clickhouseTask]) {
      const taskRoleId = roleLogicalId(task.Properties.TaskRoleArn);
      for (const action of secretReadActions) {
        expect(policyActionsForRole(taskRoleId)).not.toContain(action);
      }
    }
  });

  test('DB_CREDS는 대상 컨테이너에만 주입한다', () => {
    for (const containerName of ['post-processor', 'api-server']) {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: containerName,
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'DB_CREDS' }),
            ]),
          }),
        ]),
      });
    }

    for (const containerName of [
      'otel-collector',
      'batch-processor',
      'clickhouse',
    ]) {
      const task = taskDefinitionWithContainer(containerName);
      const container = task.Properties.ContainerDefinitions.find(
        (definition: any) => definition.Name === containerName,
      );
      expect(container.Secrets).toBeUndefined();
    }
  });

  test('clickhouse task uses awsvpc mode with a host volume', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      NetworkMode: 'awsvpc',
      Volumes: Match.arrayWith([
        Match.objectLike({
          Name: 'ch-data',
          Host: { SourcePath: '/data/clickhouse' },
        }),
      ]),
    });
  });

  test('clickhouse launch template is t4g.small with 30GB + 50GB gp3', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        InstanceType: 't4g.small',
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            DeviceName: '/dev/xvda',
            Ebs: Match.objectLike({ VolumeSize: 30, VolumeType: 'gp3' }),
          }),
          Match.objectLike({
            DeviceName: '/dev/xvdb',
            Ebs: Match.objectLike({ VolumeSize: 50, VolumeType: 'gp3' }),
          }),
        ]),
      }),
    });
  });

  test('has an ECS capacity provider', () => {
    template.resourceCountIs('AWS::ECS::CapacityProvider', 1);
  });

  test('모든 ECS 서비스에 공통 태그를 적용하고 태스크로 전파한다', () => {
    const commonTags = Object.entries(COMMON_TAGS).map(([Key, Value]) => ({
      Key,
      Value,
    }));
    const services = Object.values(
      template.findResources('AWS::ECS::Service'),
    );

    expect(services).toHaveLength(3);
    for (const service of services) {
      expect(service.Properties.PropagateTags).toBe('SERVICE');
      expect(service.Properties.Tags).toEqual(
        expect.arrayContaining(commonTags),
      );
    }
  });

  test('creates the obs.local private DNS namespace', () => {
    template.hasResourceProperties(
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      { Name: 'obs.local' },
    );
  });

  test('clickhouse service registers with Cloud Map (ServiceRegistries present)', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceRegistries: Match.anyValue(),
    });
  });
});
