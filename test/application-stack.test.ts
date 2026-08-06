import { Template, Match } from 'aws-cdk-lib/assertions';
import { load } from 'js-yaml';
import {
  CLICKHOUSE_HOST,
  COMMON_TAGS,
  CONTROL_DB_NAME,
  ECR_NAMESPACE,
  ECR_REPOS,
  PORTS,
} from '../lib/config';
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

  test('DB_NAME은 DB_CREDS를 받는 컨테이너에만 주입한다', () => {
    for (const containerName of ['post-processor', 'api-server']) {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: containerName,
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'DB_NAME', Value: CONTROL_DB_NAME }),
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
      const names = (container.Environment ?? []).map(
        (entry: any) => entry.Name,
      );
      expect(names).not.toContain('DB_NAME');
    }
  });

  test('ECS Exec은 Fargate 서비스에만 켜고 task role에 ssmmessages가 붙는다 (ADR-0016)', () => {
    const services = template.findResources('AWS::ECS::Service');
    const enabled = Object.values(services).filter(
      (service: any) => service.Properties.EnableExecuteCommand === true,
    );
    expect(enabled).toHaveLength(2);

    // ClickHouse(EC2 launch type)는 SSM 호스트 접속으로 대신하므로 제외한다.
    const clickhouse = Object.values(services).find((service: any) =>
      JSON.stringify(service.Properties).includes('ClickhouseTask'),
    ) as any;
    expect(clickhouse.Properties.EnableExecuteCommand).toBeUndefined();

    // CDK 가 task role 에 자동 부여하는 4개 액션.
    for (const containerName of ['post-processor', 'api-server']) {
      const roleId = roleLogicalId(
        taskDefinitionWithContainer(containerName).Properties.TaskRoleArn,
      );
      const actions = policyActionsForRole(roleId);
      for (const action of [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ]) {
        expect(actions).toContain(action);
      }
    }
  });

  test('ClickHouse 인스턴스 역할에 SSM 접속 권한을 부여한다 (ADR-0016)', () => {
    // Lambda drain hook 역할도 ManagedPolicyArns 를 가지므로 principal 로 구분한다.
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':iam::aws:policy/AmazonSSMManagedInstanceCore',
            ],
          ],
        },
      ]),
    });
  });

  test('Fargate 태스크는 ARM64로 고정한다 (ADR-0015)', () => {
    for (const containerName of ['otel-collector', 'api-server']) {
      const task = taskDefinitionWithContainer(containerName);
      expect(task.Properties.RuntimePlatform).toEqual({
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      });
    }

    // EC2 태스크는 인스턴스/AMI가 아키텍처를 결정한다. runtimePlatform은 Fargate 전용.
    expect(
      taskDefinitionWithContainer('clickhouse').Properties.RuntimePlatform,
    ).toBeUndefined();
  });

  test('자체 빌드 이미지는 soma-376 네임스페이스의 ECR 레포를 가리킨다 (ADR-0007)', () => {
    const ownBuiltImages: ReadonlyArray<[string, string]> = [
      ['post-processor', ECR_REPOS.postProcessor],
      ['api-server', ECR_REPOS.apiServer],
      ['batch-processor', ECR_REPOS.batchProcessor],
    ];

    for (const [containerName, repositoryName] of ownBuiltImages) {
      expect(repositoryName.startsWith(`${ECR_NAMESPACE}/`)).toBe(true);

      const task = taskDefinitionWithContainer(containerName);
      const container = task.Properties.ContainerDefinitions.find(
        (definition: any) => definition.Name === containerName,
      );

      // fromEcrRepository 는 Image 를 계정/리전 조각과 레포 이름의 Fn::Join 으로 만든다.
      // URLSuffix 같은 Ref 조각을 빼고 리터럴만 이어붙여 레포 경로를 확인한다.
      const imageLiterals: string[] = container.Image['Fn::Join'][1].filter(
        (part: unknown) => typeof part === 'string',
      );
      expect(imageLiterals.join('')).toContain(`/${repositoryName}:`);
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

  // ============================================================
  // Collector config 주입 (ADR-0017)
  // ============================================================
  describe('otel-collector config 주입', () => {
    function collectorContainer(): any {
      const task = taskDefinitionWithContainer('otel-collector');
      return task.Properties.ContainerDefinitions.find(
        (definition: any) => definition.Name === 'otel-collector',
      );
    }

    /** 합성 템플릿에 실제로 박힌 config 본문. 파일이 아니라 산출물을 검사한다. */
    function injectedConfigText(): string {
      const entry = (collectorContainer().Environment ?? []).find(
        (item: any) => item.Name === 'OTEL_CONFIG',
      );
      expect(entry).toBeDefined();
      expect(typeof entry.Value).toBe('string');
      return entry.Value as string;
    }

    function injectedConfig(): any {
      return load(injectedConfigText());
    }

    test('env provider 로 config 를 읽도록 command 를 덮어쓴다', () => {
      expect(collectorContainer().Command).toEqual([
        '--config=env:OTEL_CONFIG',
      ]);
    });

    test('OTEL_CONFIG 환경변수에 config 본문이 들어간다', () => {
      const config = injectedConfig();
      expect(config.receivers).toBeDefined();
      expect(config.exporters).toBeDefined();
      expect(config.service.pipelines).toBeDefined();
    });

    // cdk synth 도 npm test 도 config 를 문자열로만 다루므로 컴포넌트 이름 오타를
    // 그냥 통과시킨다. 이 레포엔 빌드 CI 가 없어 컨테이너가 죽고 나서야 드러난다.
    test('파이프라인이 참조하는 컴포넌트가 전부 정의되어 있다', () => {
      const config = injectedConfig();
      const pipelines = Object.entries<any>(config.service.pipelines);
      expect(pipelines.length).toBeGreaterThan(0);

      for (const [pipelineName, pipeline] of pipelines) {
        for (const kind of ['receivers', 'processors', 'exporters'] as const) {
          const defined = Object.keys(config[kind] ?? {});
          for (const component of pipeline[kind] ?? []) {
            // 실패 메시지에 어느 파이프라인인지 남기려고 라벨을 함께 비교한다.
            expect({
              pipeline: pipelineName,
              missing: defined.includes(component) ? null : `${kind}/${component}`,
            }).toEqual({ pipeline: pipelineName, missing: null });
          }
        }
      }
    });

    test('정의만 되고 어느 파이프라인도 쓰지 않는 컴포넌트가 없다', () => {
      const config = injectedConfig();
      const used = new Set<string>();
      for (const pipeline of Object.values<any>(config.service.pipelines)) {
        for (const kind of ['receivers', 'processors', 'exporters'] as const) {
          for (const component of pipeline[kind] ?? []) {
            used.add(`${kind}/${component}`);
          }
        }
      }

      const orphans: string[] = [];
      for (const kind of ['receivers', 'processors', 'exporters'] as const) {
        for (const component of Object.keys(config[kind] ?? {})) {
          if (!used.has(`${kind}/${component}`)) {
            orphans.push(`${kind}/${component}`);
          }
        }
      }
      expect(orphans).toEqual([]);
    });

    // SG(network-stack)와 ALB 타깃 그룹(edge-stack)이 4318 만 다룬다. config 에만
    // 4317 을 열면 아무도 도달 못 하는 포트를 바인딩하게 된다. (ADR-0017)
    test('gRPC(4317) 를 열지 않고 HTTP(4318) 만 수신한다', () => {
      const protocols = injectedConfig().receivers.otlp.protocols;

      // 주석에도 4317 이 나오므로 원문 문자열이 아니라 구조를 본다.
      expect(Object.keys(protocols)).toEqual(['http']);
      expect(protocols.http.endpoint).toBe(`0.0.0.0:${PORTS.otlp}`);
    });

    // Fargate 는 awsvpc 라 같은 태스크의 컨테이너가 netns 를 공유한다.
    // Cloud Map 주소나 compose 서비스명이 아니라 localhost 여야 한다. (ADR-0017)
    test('post-processor 로는 localhost 로 내보낸다', () => {
      const exporters = injectedConfig().exporters;

      expect(exporters['otlphttp/telemetry_pipeline'].endpoint).toBe(
        `http://localhost:${PORTS.postProcessor}`,
      );

      // ClickHouse 직접 export 는 ADR-0004 파이프라인을 우회한다. 그렇게 바꾸려면
      // ADR 을 먼저 갱신해야 하므로, 조용히 들어오는 것을 막는다.
      const endpoints = Object.values<any>(exporters)
        .map((exporter) => exporter?.endpoint)
        .filter((endpoint): endpoint is string => typeof endpoint === 'string');
      expect(
        endpoints.filter((endpoint) => endpoint.includes(CLICKHOUSE_HOST)),
      ).toEqual([]);
    });

    test('post-processor 컨테이너가 그 포트를 노출한다', () => {
      const task = taskDefinitionWithContainer('post-processor');
      const container = task.Properties.ContainerDefinitions.find(
        (definition: any) => definition.Name === 'post-processor',
      );

      expect(container.PortMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ContainerPort: PORTS.postProcessor }),
        ]),
      );
    });

    // config 는 CloudFormation 템플릿과 ECS 콘솔에 평문으로 남는다. (ADR-0017)
    test('config 를 secrets 가 아니라 environment 로 넘긴다', () => {
      expect(collectorContainer().Secrets).toBeUndefined();
    });

    // 태스크 정의 전체가 64 KiB 를 넘으면 RegisterTaskDefinition 이 거부한다.
    // 지금은 약 5 KB 라 여유가 크지만, 조용히 한도에 접근하는 것을 막는다.
    test('config 가 태스크 정의 한도를 위협할 만큼 커지지 않았다', () => {
      expect(Buffer.byteLength(injectedConfigText(), 'utf8')).toBeLessThan(
        16 * 1024,
      );
    });

    // 이 이미지는 User=10001:10001 이고 UID 10001 이 쓸 수 있는 디렉터리가 없다
    // (scratch 기반이라 /tmp 도 없다). file exporter 가 /data 를 만들려면 root 가
    // 필요하다. 최초 배포가 정확히 이것 때문에 exit 1 로 죽었다. (ADR-0017)
    test('collector 를 root 로 실행한다', () => {
      expect(collectorContainer().User).toBe('0');
    });

    // 이번 장애의 재발 방지 핵심.
    // file exporter 와 root 실행은 한 몸이다. 한쪽만 지우면 여기서 걸린다.
    // - file exporter 를 남긴 채 user 를 지우면 → 런타임에 exit 1
    // - awss3 로 옮기면서 user 를 안 지우면 → 불필요한 root 권한 잔존
    test('file exporter 와 root 실행은 함께 존재하거나 함께 사라진다', () => {
      const exporters = injectedConfig().exporters;
      const usesFileExporter = Object.keys(exporters).some((name) =>
        name.startsWith('file/'),
      );
      const runsAsRoot = collectorContainer().User === '0';

      expect({ usesFileExporter, runsAsRoot }).toEqual({
        usesFileExporter: runsAsRoot,
        runsAsRoot,
      });
    });

    // root 범위를 collector 한 컨테이너로 한정한다. post-processor 는 자체 이미지라
    // 쓰기 가능한 유저로 빌드하면 될 문제지 root 로 올릴 이유가 없다.
    test('root 실행은 collector 에만 적용한다', () => {
      const task = taskDefinitionWithContainer('post-processor');
      const container = task.Properties.ContainerDefinitions.find(
        (definition: any) => definition.Name === 'post-processor',
      );

      expect(container.User).toBeUndefined();
    });
  });
});
