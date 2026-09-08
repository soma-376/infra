import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  CLICKHOUSE_DEFAULT_DB,
  CLICKHOUSE_HTTP_URL,
  CLICKHOUSE_IMAGE,
  CLOUD_MAP_NAMESPACE,
  CONTROL_DB_NAME,
  CONTROL_DB_SSLMODE,
  ECR_NAMESPACE,
  ECR_REPOS,
  ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY,
  ENROLLMENT_ENV,
  INGEST_ENV,
  PORTS,
} from '../../lib/common/config';
import {
  DEV_ENROLLMENT_BINARIES_DIR,
  DEV_LOG_GROUP_PREFIX,
  DEV_TELEMETRY_ARCHIVE_PREFIX,
  DEV_TELEMETRY_INGEST_HEALTH_CHECK_GRACE,
} from '../../lib/dev/config';
import { PROD_IMAGE_TAG } from '../../lib/prod/config';
import {
  ECS_CLUSTER_NAMES,
  ECS_SERVICE_NAMES,
} from '../../lib/common/deploy-targets';
import { buildDevApp } from '../helpers';

describe('DevApplicationStack', () => {
  const { application, edge } = buildDevApp();
  const template = Template.fromStack(application);
  const edgeTemplate = Template.fromStack(edge).toJSON();

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

  function container(containerName: string): any {
    return taskDefinitionWithContainer(
      containerName,
    ).Properties.ContainerDefinitions.find(
      (definition: any) => definition.Name === containerName,
    );
  }

  function service(serviceName: string): any {
    const found = Object.values(
      template.findResources('AWS::ECS::Service'),
    ).filter((resource: any) => resource.Properties.ServiceName === serviceName);

    expect(found).toHaveLength(1);
    return found[0];
  }

  // ============================================================
  // 물리 이름 - 앱 레포 워크플로우와의 계약 (ADR-0024)
  // ============================================================
  //
  // 이 이름들은 `DeployStack` 이 IAM 서비스 ARN 을 조립할 때 쓰는 값과 같아야 한다.
  // 어긋나도 synth·test·deploy 는 전부 통과하고 GitHub Actions 만 AccessDenied 로
  // 죽는다 - CloudFormation 은 IAM 정책의 리소스 ARN 실존을 검증하지 않는다.
  // 양쪽이 실제로 맞물리는지는 `test/cicd/deploy-stack.test.ts` 가 교차 검증한다.
  describe('ECS 물리 이름', () => {
    // 클러스터 이름은 계정 + 리전에서 유일하다. 운영과 같으면 dev 첫 배포가 깨진다.
    test('클러스터 이름이 운영과 다르다', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: ECS_CLUSTER_NAMES.dev,
      });
      expect(ECS_CLUSTER_NAMES.dev).not.toBe(ECS_CLUSTER_NAMES.prod);
    });

    // 서비스 이름은 유일성 스코프가 클러스터 안이라 운영과 같은 이름을 쓴다.
    // 그래야 워크플로우가 `--cluster` 하나만 갈아끼워 환경을 바꿀 수 있다.
    test('최종 서비스 3개의 이름이 고정되어 있다', () => {
      const names = Object.values(template.findResources('AWS::ECS::Service'))
        .map((resource: any) => resource.Properties.ServiceName)
        .sort();

      expect(names).toEqual(
        [
          ECS_SERVICE_NAMES.telemetryIngest,
          ECS_SERVICE_NAMES.enrollmentApi,
          ECS_SERVICE_NAMES.clickhouse,
        ].sort(),
      );

      expect(application.telemetryIngestService).toBeDefined();
      expect(application.enrollmentApiTask).toBeDefined();
      expect(application.enrollmentApiService).toBeDefined();
    });
  });

  const envMap = (containerName: string): Record<string, unknown> =>
    Object.fromEntries(
      (container(containerName).Environment ?? []).map((entry: any) => [
        entry.Name,
        entry.Value,
      ]),
    );

  const secretNames = (containerName: string): string[] =>
    (container(containerName).Secrets ?? []).map((entry: any) => entry.Name);

  const secretEntry = (containerName: string, secretName: string): any => {
    const found = (container(containerName).Secrets ?? []).filter(
      (entry: any) => entry.Name === secretName,
    );
    expect(found).toHaveLength(1);
    return found[0];
  };

  // ============================================================
  // 네트워크 모드 - 최종 서비스 배치 계약 (ADR-0026)
  // ============================================================
  describe('태스크 네트워크 모드', () => {
    test('telemetry-ingest와 enrollment-api는 bridge다', () => {
      for (const name of ['telemetry-ingest', 'enrollment-api']) {
        expect(taskDefinitionWithContainer(name).Properties.NetworkMode).toBe(
          'bridge',
        );
      }
    });

    // ClickHouse Cloud Map A 레코드는 태스크 전용 IP가 있어야 한다. bridge로
    // 바꾸면 SRV만 등록되어 일반 HTTP 클라이언트가 주소를 해석하지 못한다.
    test('clickhouse는 Cloud Map A 레코드를 위해 awsvpc를 유지한다', () => {
      expect(
        taskDefinitionWithContainer('clickhouse').Properties.NetworkMode,
      ).toBe('awsvpc');
    });

    test('최종 태스크 정의는 bridge 2개와 awsvpc 1개뿐이다', () => {
      const tasks = Object.values(
        template.findResources('AWS::ECS::TaskDefinition'),
      ) as any[];

      expect(tasks).toHaveLength(3);
      expect(
        tasks.filter((task) => task.Properties.NetworkMode === 'bridge'),
      ).toHaveLength(2);
      expect(
        tasks.filter((task) => task.Properties.NetworkMode === 'awsvpc'),
      ).toHaveLength(1);
    });
  });

  // ============================================================
  // telemetry-ingest 배포 단위 (PROJ-140, ADR-0026)
  // ============================================================
  describe('telemetry-ingest 배포 단위', () => {
    test('4316 컨테이너 포트를 열고 hostPort 는 동적으로 할당한다', () => {
      const portMappings = container('telemetry-ingest').PortMappings;

      expect(portMappings).toHaveLength(1);
      expect(portMappings[0]).toMatchObject({
        ContainerPort: PORTS.telemetryIngest,
        HostPort: 0,
        Protocol: 'tcp',
      });
      expect(PORTS.telemetryIngest).toBe(4316);
    });

    test('소프트 메모리 예약은 1024 MiB다', () => {
      expect(container('telemetry-ingest').MemoryReservation).toBe(1024);
      expect(container('telemetry-ingest').Memory).toBeUndefined();
    });

    test('ALB binding과 240초 health check 기동 유예를 적용한다', () => {
      const properties = service(ECS_SERVICE_NAMES.telemetryIngest).Properties;

      expect(properties.LoadBalancers).toHaveLength(1);
      expect(properties.LoadBalancers[0]).toMatchObject({
        ContainerName: 'telemetry-ingest',
        ContainerPort: PORTS.telemetryIngest,
      });
      expect(JSON.stringify(properties.LoadBalancers[0].TargetGroupArn)).toContain(
        'DevEdgeStack',
      );
      expect(properties.HealthCheckGracePeriodSeconds).toBe(
        DEV_TELEMETRY_INGEST_HEALTH_CHECK_GRACE.toSeconds(),
      );
      expect(DEV_TELEMETRY_INGEST_HEALTH_CHECK_GRACE.toSeconds()).toBe(240);
    });
  });

  // ============================================================
  // telemetry-ingest 런타임 계약 (PROJ-141, ADR-0026)
  // ============================================================
  describe('telemetry-ingest 런타임 계약', () => {
    test('application.yaml의 PULSEMETRY 이름만 정확히 사용한다', () => {
      expect(Object.values(INGEST_ENV).sort()).toEqual(
        [
          'PULSEMETRY_INGEST_PORT',
          'PULSEMETRY_DB_URL',
          'PULSEMETRY_DB_USERNAME',
          'PULSEMETRY_DB_PASSWORD',
          'PULSEMETRY_TOKEN_HASH_SECRET',
          'PULSEMETRY_CLICKHOUSE_URL',
          'PULSEMETRY_CLICKHOUSE_DATABASE',
          'PULSEMETRY_ARCHIVE_TYPE',
          'PULSEMETRY_ARCHIVE_BUCKET',
          'PULSEMETRY_ARCHIVE_PREFIX',
        ].sort(),
      );

      expect(
        [
          ...Object.keys(envMap('telemetry-ingest')),
          ...secretNames('telemetry-ingest'),
        ].sort(),
      ).toEqual(Object.values(INGEST_ENV).sort());
    });

    test('비밀이 아닌 포트·RDS·ClickHouse·S3 설정을 environment에 넣는다', () => {
      const env = envMap('telemetry-ingest');

      expect(env[INGEST_ENV.port]).toBe(String(PORTS.telemetryIngest));

      const dbUrl = JSON.stringify(env[INGEST_ENV.dbUrl]);
      expect(dbUrl).toContain('jdbc:postgresql://');
      expect(dbUrl).toContain(
        `:${PORTS.aurora}/${CONTROL_DB_NAME}?sslmode=${CONTROL_DB_SSLMODE}`,
      );

      expect(env[INGEST_ENV.clickhouseUrl]).toBe(CLICKHOUSE_HTTP_URL);
      expect(env[INGEST_ENV.clickhouseDatabase]).toBe(CLICKHOUSE_DEFAULT_DB);
      expect(env[INGEST_ENV.archiveType]).toBe('s3');
      expect(env[INGEST_ENV.archiveBucket]).toBeDefined();
      expect(env[INGEST_ENV.archivePrefix]).toBe(
        DEV_TELEMETRY_ARCHIVE_PREFIX,
      );
      expect(DEV_TELEMETRY_ARCHIVE_PREFIX).toBe('');
    });

    test('RDS JSON 필드와 기존 token hash만 ECS secrets로 주입한다', () => {
      expect(secretNames('telemetry-ingest').sort()).toEqual(
        [
          INGEST_ENV.dbUsername,
          INGEST_ENV.dbPassword,
          INGEST_ENV.tokenHashSecret,
        ].sort(),
      );
      expect(
        JSON.stringify(
          secretEntry('telemetry-ingest', INGEST_ENV.dbUsername).ValueFrom,
        ),
      ).toContain(':username::');
      expect(
        JSON.stringify(
          secretEntry('telemetry-ingest', INGEST_ENV.dbPassword).ValueFrom,
        ),
      ).toContain(':password::');
      expect(
        secretEntry('telemetry-ingest', INGEST_ENV.tokenHashSecret).ValueFrom,
      ).toEqual(
        secretEntry('enrollment-api', ENROLLMENT_ENV.tokenHashSecret).ValueFrom,
      );
    });

    test('민감값은 일반 환경변수와 CloudFormation output에 나타나지 않는다', () => {
      const environment = JSON.stringify(
        container('telemetry-ingest').Environment,
      );
      const outputs = JSON.stringify(template.findOutputs('*'));

      for (const secretName of [
        INGEST_ENV.dbUsername,
        INGEST_ENV.dbPassword,
        INGEST_ENV.tokenHashSecret,
      ]) {
        expect(Object.keys(envMap('telemetry-ingest'))).not.toContain(
          secretName,
        );
        expect(outputs).not.toContain(secretName);
      }
      expect(environment).not.toContain('resolve:secretsmanager');
      expect(outputs).not.toContain('resolve:secretsmanager');
    });

    test('Raw Signal 버킷 read/write를 telemetry-ingest task role에만 연결한다', () => {
      const taskDefinition = taskDefinitionWithContainer('telemetry-ingest');
      const taskRoleLogicalId = taskDefinition.Properties.TaskRoleArn[
        'Fn::GetAtt'
      ][0] as string;
      const statements = Object.values(
        template.findResources('AWS::IAM::Policy'),
      ).flatMap((policy: any) =>
        policy.Properties.Roles.some(
          (role: any) => role.Ref === taskRoleLogicalId,
        )
          ? policy.Properties.PolicyDocument.Statement
          : [],
      );
      const actions = statements.flatMap((statement: any) =>
        Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action],
      );

      expect(actions).toEqual(
        expect.arrayContaining([
          's3:GetObject*',
          's3:PutObject',
          's3:DeleteObject*',
        ]),
      );
      expect(actions.every((action: string) => action.startsWith('s3:'))).toBe(
        true,
      );
      expect(
        statements.every((statement: any) => statement.Resource !== '*'),
      ).toBe(true);
    });
  });

  // ============================================================
  // 신규 enrollment-api 배포 단위와 런타임 계약 (PROJ-142, ADR-0026)
  // ============================================================
  describe('신규 enrollment-api 배포 단위', () => {
    test('독립 태스크에 enrollment-api 컨테이너 하나만 둔다', () => {
      const definitions = taskDefinitionWithContainer('enrollment-api')
        .Properties.ContainerDefinitions;

      expect(definitions.map((definition: any) => definition.Name)).toEqual([
        'enrollment-api',
      ]);
    });

    test('8080 동적 host port와 1024 MiB 소프트 예약을 쓴다', () => {
      const definition = container('enrollment-api');

      expect(definition.PortMappings).toEqual([
        {
          ContainerPort: PORTS.enrollmentApi,
          HostPort: 0,
          Protocol: 'tcp',
        },
      ]);
      expect(PORTS.enrollmentApi).toBe(8080);
      expect(definition.MemoryReservation).toBe(1024);
      expect(definition.Memory).toBeUndefined();
    });

    test('ALB binding을 추가하고 CDK 기본 60초 기동 유예를 유지한다', () => {
      const properties = service(ECS_SERVICE_NAMES.enrollmentApi).Properties;

      expect(properties.LoadBalancers).toHaveLength(1);
      expect(properties.LoadBalancers[0]).toMatchObject({
        ContainerName: 'enrollment-api',
        ContainerPort: PORTS.enrollmentApi,
      });
      expect(JSON.stringify(properties.LoadBalancers[0].TargetGroupArn)).toContain(
        'DevEdgeStack',
      );
      expect(properties.HealthCheckGracePeriodSeconds).toBe(60);
    });

    test('application.yaml의 PULSEMETRY 이름 7개만 정확히 사용한다', () => {
      expect(Object.values(ENROLLMENT_ENV).sort()).toEqual(
        [
          'PULSEMETRY_DB_URL',
          'PULSEMETRY_DB_USERNAME',
          'PULSEMETRY_DB_PASSWORD',
          'PULSEMETRY_ADMIN_API_TOKEN',
          'PULSEMETRY_TOKEN_HASH_SECRET',
          'PULSEMETRY_PUBLIC_BASE_URL',
          'PULSEMETRY_BINARIES_DIR',
        ].sort(),
      );
      expect(
        [
          ...Object.keys(envMap('enrollment-api')),
          ...secretNames('enrollment-api'),
        ].sort(),
      ).toEqual(Object.values(ENROLLMENT_ENV).sort());
    });

    test('JDBC URL·실제 ALB base URL·바이너리 경로를 일반 env로 넣는다', () => {
      const env = envMap('enrollment-api');
      const dbUrl = JSON.stringify(env[ENROLLMENT_ENV.dbUrl]);
      const publicBaseUrl = env[ENROLLMENT_ENV.publicBaseUrl] as any;

      expect(dbUrl).toContain('jdbc:postgresql://');
      expect(dbUrl).toContain(
        `:${PORTS.aurora}/${CONTROL_DB_NAME}?sslmode=${CONTROL_DB_SSLMODE}`,
      );
      expect(publicBaseUrl).toEqual({
        'Fn::Join': [
          '',
          [
            'http://',
            {
              'Fn::GetStackOutput': {
                StackName: 'DevEdgeStack',
                OutputName: expect.any(String),
                Region: expect.any(String),
              },
            },
          ],
        ],
      });

      const outputName =
        publicBaseUrl['Fn::Join'][1][1]['Fn::GetStackOutput'].OutputName;
      const albDnsOutput = edgeTemplate.Outputs[outputName];
      const [albLogicalId, attribute] = albDnsOutput.Value['Fn::GetAtt'];

      expect(attribute).toBe('DNSName');
      expect(edgeTemplate.Resources[albLogicalId]).toMatchObject({
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      });
      expect(JSON.stringify(publicBaseUrl)).not.toContain('localhost');
      expect(env[ENROLLMENT_ENV.binariesDir]).toBe(
        DEV_ENROLLMENT_BINARIES_DIR,
      );
      expect(DEV_ENROLLMENT_BINARIES_DIR).toBe('/app/binaries');
    });

    test('DB·관리자 토큰·token hash 네 값만 ECS secrets로 주입한다', () => {
      expect(secretNames('enrollment-api').sort()).toEqual(
        [
          ENROLLMENT_ENV.dbUsername,
          ENROLLMENT_ENV.dbPassword,
          ENROLLMENT_ENV.adminApiToken,
          ENROLLMENT_ENV.tokenHashSecret,
        ].sort(),
      );
      expect(
        JSON.stringify(
          secretEntry('enrollment-api', ENROLLMENT_ENV.dbUsername).ValueFrom,
        ),
      ).toContain(':username::');
      expect(
        JSON.stringify(
          secretEntry('enrollment-api', ENROLLMENT_ENV.dbPassword).ValueFrom,
        ),
      ).toContain(':password::');
      expect(
        JSON.stringify(
          secretEntry('enrollment-api', ENROLLMENT_ENV.adminApiToken)
            .ValueFrom,
        ),
      ).toContain(`:${ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY}::`);
      expect(
        secretEntry('enrollment-api', ENROLLMENT_ENV.tokenHashSecret)
          .ValueFrom,
      ).toEqual(
        secretEntry('telemetry-ingest', INGEST_ENV.tokenHashSecret).ValueFrom,
      );
    });

    test('민감값은 신규 컨테이너의 일반 env에 나타나지 않는다', () => {
      const env = envMap('enrollment-api');
      const serialized = JSON.stringify(
        container('enrollment-api').Environment,
      );

      for (const secretName of [
        ENROLLMENT_ENV.dbUsername,
        ENROLLMENT_ENV.dbPassword,
        ENROLLMENT_ENV.adminApiToken,
        ENROLLMENT_ENV.tokenHashSecret,
      ]) {
        expect(Object.keys(env)).not.toContain(secretName);
      }
      expect(serialized).not.toContain('resolve:secretsmanager');
    });
  });

  // ============================================================
  // 최종 리소스 집합과 로그 수명주기 (ADR-0026)
  // ============================================================
  describe('최종 리소스 집합', () => {
    const finalContainerNames = [
      'telemetry-ingest',
      'enrollment-api',
      'clickhouse',
    ];
    const removedContainerNames = [
      'otel-collector',
      'post-processor',
      'auth-proxy',
      'api-server',
      'batch-processor',
    ];

    test('구 컨테이너와 태스크 정의를 제거하고 최종 3개만 남긴다', () => {
      const tasks = Object.values(
        template.findResources('AWS::ECS::TaskDefinition'),
      ) as any[];
      const names = tasks.flatMap((task) =>
        task.Properties.ContainerDefinitions.map(
          (definition: any) => definition.Name,
        ),
      );

      expect(tasks).toHaveLength(3);
      expect(names.sort()).toEqual([...finalContainerNames].sort());
      for (const removed of removedContainerNames) {
        expect(names).not.toContain(removed);
      }
    });

    test('최종 로그 그룹 3개는 /ecs/dev 접두, 14일 보존, 삭제 정책을 쓴다', () => {
      const logGroups = Object.values(
        template.findResources('AWS::Logs::LogGroup'),
      ).filter(
        (resource: any) => typeof resource.Properties.LogGroupName === 'string',
      ) as any[];
      const names = logGroups.map(
        (resource) => resource.Properties.LogGroupName,
      );

      expect(names.sort()).toEqual(
        [
          `${DEV_LOG_GROUP_PREFIX}/telemetry-ingest`,
          `${DEV_LOG_GROUP_PREFIX}/enrollment-api`,
          `${DEV_LOG_GROUP_PREFIX}/clickhouse`,
        ].sort(),
      );
      for (const resource of logGroups) {
        expect(resource).toMatchObject({
          DeletionPolicy: 'Delete',
          UpdateReplacePolicy: 'Delete',
          Properties: { RetentionInDays: 14 },
        });
      }
    });
  });

  // ============================================================
  // ClickHouse 컨테이너 (ADR-0019)
  // ============================================================
  describe('clickhouse 컨테이너', () => {
    // 태그가 없으면 latest 로 해석되어 재기동마다 메이저 버전이 바뀔 수 있고,
    // 아래 env 가 의존하는 entrypoint 분기 로직 자체가 버전에 따라 변한다.
    test('이미지 태그를 운영과 같은 상수로 고정한다', () => {
      expect(container('clickhouse').Image).toBe(CLICKHOUSE_IMAGE);
      expect(container('clickhouse').Image).toContain(':');
    });

    // **이 값을 지우면 이미지 entrypoint 가 default 유저를 루프백 전용으로 잠가
    // telemetry-ingest의 모든 적재가 403(Authentication failed)으로 죽는다.**
    // 앱이 그걸 BackendUnavailable 로 감싸 리시버가 503 을 뱉으며, synth 도 test 도
    // deploy 도 전부 통과한다 - 운영에서 실제로 이렇게 깨졌다. (ADR-0019)
    test('CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT 가 1 이다', () => {
      expect(envMap('clickhouse').CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT).toBe(
        '1',
      );
    });

    // 서버가 만드는 DB와 telemetry-ingest가 쓰는 DB가 갈라지면 적재 대상
    // 테이블이 서로 다른 DB에 생긴다.
    test('컨테이너 DB 이름은 telemetry-ingest가 쓰는 DB와 같다', () => {
      expect(envMap('clickhouse').CLICKHOUSE_DB).toBe(CLICKHOUSE_DEFAULT_DB);
    });
  });

  // ============================================================
  // ECR 이미지 (ADR-0007, ADR-0021 5번)
  // ============================================================
  describe('자체 빌드 이미지', () => {
    const ownBuilt: ReadonlyArray<readonly [string, string]> = [
      ['telemetry-ingest', ECR_REPOS.telemetryIngest],
      ['enrollment-api', ECR_REPOS.enrollmentApi],
    ];

    const imageLiterals = (containerName: string): string =>
      (container(containerName).Image['Fn::Join'][1] as unknown[])
        .filter((part): part is string => typeof part === 'string')
        .join('');

    test('최종 두 앱 이미지는 soma-376 ECR 레포와 :dev 태그를 쓴다', () => {
      for (const [containerName, repositoryName] of ownBuilt) {
        const image = imageLiterals(containerName);
        expect(repositoryName.startsWith(`${ECR_NAMESPACE}/`)).toBe(true);
        expect(image).toContain(`/${repositoryName}:dev`);
        expect(image).not.toContain(':latest');
        expect(image).not.toContain(`:${PROD_IMAGE_TAG}`);
      }
    });
  });

  test('devImageTag를 주면 최종 두 앱 이미지에만 그 태그가 붙는다', () => {
    const tagged = Template.fromStack(
      buildDevApp({ devImageTag: 'pr-42' }).application,
    );
    const images = Object.values(
      tagged.findResources('AWS::ECS::TaskDefinition'),
    ).flatMap((resource: any) =>
      resource.Properties.ContainerDefinitions.map(
        (definition: any) => definition.Image,
      ),
    );
    const ecrImages = images
      .filter((image: any) => typeof image === 'object')
      .map((image: any) =>
        (image['Fn::Join'][1] as unknown[])
          .filter((part): part is string => typeof part === 'string')
          .join(''),
      );

    expect(ecrImages).toHaveLength(2);
    for (const image of ecrImages) {
      expect(image).toContain(':pr-42');
      expect(image).not.toContain(':latest');
    }
  });

  // ============================================================
  // 서비스 / ASG
  // ============================================================
  describe('ECS 서비스', () => {
    const services = (): any[] =>
      Object.values(template.findResources('AWS::ECS::Service'));

    test('최종 세 서비스는 교체 배포(0/100, desired 1)로 고정한다', () => {
      expect(services()).toHaveLength(3);
      for (const resource of services()) {
        expect(resource.Properties.DesiredCount).toBe(1);
        expect(resource.Properties.DeploymentConfiguration).toMatchObject({
          MinimumHealthyPercent: 0,
          MaximumPercent: 100,
        });
      }
    });

    test('신규 두 앱과 ClickHouse의 ALB binding을 유지한다', () => {
      for (const [serviceName, containerName, containerPort] of [
        [
          ECS_SERVICE_NAMES.telemetryIngest,
          'telemetry-ingest',
          PORTS.telemetryIngest,
        ],
        [
          ECS_SERVICE_NAMES.enrollmentApi,
          'enrollment-api',
          PORTS.enrollmentApi,
        ],
        [ECS_SERVICE_NAMES.clickhouse, 'clickhouse', PORTS.clickhouseHttp],
      ] as const) {
        const loadBalancers = service(serviceName).Properties.LoadBalancers;

        expect(loadBalancers).toHaveLength(1);
        expect(loadBalancers[0]).toMatchObject({
          ContainerName: containerName,
          ContainerPort: containerPort,
        });
        expect(loadBalancers[0].TargetGroupArn).toBeDefined();
      }
    });

    test('240초 health check 기동 유예는 telemetry-ingest에만 적용한다', () => {
      const withExtendedGrace = services()
        .filter(
          (resource: any) =>
            resource.Properties.HealthCheckGracePeriodSeconds === 240,
        )
        .map((resource: any) => resource.Properties.ServiceName);

      expect(withExtendedGrace).toEqual([ECS_SERVICE_NAMES.telemetryIngest]);
      expect(service(ECS_SERVICE_NAMES.enrollmentApi).Properties).toMatchObject({
        HealthCheckGracePeriodSeconds: 60,
      });
    });

    test('모든 서비스가 ECS Exec을 켜지 않는다', () => {
      for (const resource of services()) {
        expect(resource.Properties.EnableExecuteCommand).toBeUndefined();
      }
    });

    test('앱 호스트 소프트 예약 합은 2048 MiB다', () => {
      const reservations = ['telemetry-ingest', 'enrollment-api'].map(
        (name) => container(name).MemoryReservation as number,
      );

      expect(reservations.reduce((sum, value) => sum + value, 0)).toBe(2048);
    });
  });

  describe('호스트 ASG', () => {
    const asgs = (targetTemplate: Template): Record<string, any> =>
      targetTemplate.findResources('AWS::AutoScaling::AutoScalingGroup');

    const asgByPrefix = (
      targetTemplate: Template,
      prefix: string,
    ): any => {
      const entry = Object.entries(asgs(targetTemplate)).find(([key]) =>
        key.startsWith(prefix),
      );
      expect(entry).toBeDefined();
      return entry![1];
    };

    // ClickHouse 쿼리 하나가 앱 태스크를 OOM 으로 밀어내는 것을 막고, 데이터
    // 디렉터리를 비울 때 앱 호스트를 함께 내리지 않아도 되게 한다. (ADR-0022 3번)
    test('앱 호스트와 ClickHouse 호스트로 ASG 를 2개 나눈다', () => {
      expect(Object.keys(asgs(template))).toHaveLength(2);
    });

    // ClickHouse 태스크는 호스트 볼륨에 묶여 있어 다중화가 의미 없다.
    test('ClickHouse ASG 의 최대 용량은 1 로 고정한다', () => {
      expect(asgByPrefix(template, 'DevClickhouseAsg').Properties.MaxSize).toBe(
        '1',
      );
    });

    test('최종 앱 ASG의 최대 용량 기본값은 1이다', () => {
      expect(asgByPrefix(template, 'DevAppAsg').Properties.MaxSize).toBe('1');
    });

    // 부하 테스트 확장 손잡이. 앱 ASG 만 늘어나고 ClickHouse 는 1 로 남아야 한다.
    // (ADR-0022 11번)
    test('devAppAsgMaxCapacity 는 앱 ASG 만 늘린다', () => {
      const scaled = Template.fromStack(
        buildDevApp({ devAppAsgMaxCapacity: '3' }).application,
      );

      expect(asgByPrefix(scaled, 'DevAppAsg').Properties.MaxSize).toBe('3');
      expect(asgByPrefix(scaled, 'DevClickhouseAsg').Properties.MaxSize).toBe(
        '1',
      );
    });

    // **buildDevApp 이 cdk.json 의 피처 플래그를 제대로 읽었다는 증거다.**
    // bare `new App()` 으로 합성하면 ASG 가 LaunchTemplate 이 아니라 폐기된
    // LaunchConfiguration 을 만들어 CLI synth 와 산출물이 갈린다 - AGENTS.md 7장이
    // 경고한 바로 그 함정이고, 그 상태로는 이 스위트의 나머지 어서션도 전부
    // "테스트에서만 참"이 된다.
    test('ASG 가 LaunchTemplate 을 쓴다 (LaunchConfiguration 0개)', () => {
      template.resourceCountIs('AWS::AutoScaling::LaunchConfiguration', 0);
      template.resourceCountIs('AWS::EC2::LaunchTemplate', 2);
    });
  });

  // ============================================================
  // Cloud Map (ADR-0005, ADR-0022 4번)
  // ============================================================
  describe('Cloud Map 서비스 디스커버리', () => {
    // 네임스페이스 이름이 운영과 같아야 CLICKHOUSE_HTTP_URL 이 한 값으로 유지된다.
    // private DNS 네임스페이스는 VPC 스코프라 동명이 둘 있어도 충돌하지 않는다.
    test('obs.local 프라이빗 DNS 네임스페이스를 만든다', () => {
      template.hasResourceProperties(
        'AWS::ServiceDiscovery::PrivateDnsNamespace',
        { Name: CLOUD_MAP_NAMESPACE },
      );
    });

    // **A 레코드는 awsvpc 태스크에서만 등록된다.** bridge/host 모드면 Cloud Map 이
    // SRV 만 등록하고, SRV 는 일반 HTTP 클라이언트가 해석하지 못해
    // telemetry-ingest의 ClickHouse URL이 깨진다. 위 clickhouse 태스크의
    // awsvpc 어서션과 짝이다. (ADR-0005, ADR-0022 4번)
    test('ClickHouse 서비스를 A 레코드로 등록한다', () => {
      template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
        DnsConfig: Match.objectLike({
          DnsRecords: Match.arrayWith([Match.objectLike({ Type: 'A' })]),
        }),
      });
    });
  });
});
