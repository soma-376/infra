import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  CLICKHOUSE_DEFAULT_DB,
  CLICKHOUSE_HTTP_URL,
  CLICKHOUSE_IMAGE,
  CLOUD_MAP_NAMESPACE,
  COLLECTOR_OTLP_URL,
  COLLECTOR_SERVICE_NAME,
  ECR_NAMESPACE,
  ECR_REPOS,
  ENRICHMENT_ENV,
  PORTS,
} from '../../lib/common/config';
import { DEV_LOG_GROUP_PREFIX } from '../../lib/dev/config';
import { PROD_IMAGE_TAG } from '../../lib/prod/config';
import {
  ECS_CLUSTER_NAMES,
  ECS_SERVICE_NAMES,
} from '../../lib/common/deploy-targets';
import { buildDevApp } from '../helpers';

describe('DevApplicationStack', () => {
  const { application } = buildDevApp();
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

  function container(containerName: string): any {
    return taskDefinitionWithContainer(
      containerName,
    ).Properties.ContainerDefinitions.find(
      (definition: any) => definition.Name === containerName,
    );
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
    test('서비스 4개의 이름이 고정되어 있다', () => {
      const names = Object.values(template.findResources('AWS::ECS::Service'))
        .map((resource: any) => resource.Properties.ServiceName)
        .sort();

      expect(names).toEqual(
        [
          ECS_SERVICE_NAMES.collector,
          ECS_SERVICE_NAMES.authProxy,
          ECS_SERVICE_NAMES.dashboard,
          ECS_SERVICE_NAMES.clickhouse,
        ].sort(),
      );
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

  // ============================================================
  // 네트워크 모드 - 이 설계의 핵심 방어선 (ADR-0022 4번)
  // ============================================================
  describe('태스크 네트워크 모드', () => {
    // **awsvpc 여야 한다.** config/otel-collector.yaml 의 exporter 가
    // `http://localhost:8080` 으로 같은 태스크의 post-processor 를 부르는데, 태스크
    // 내 컨테이너가 네트워크 네임스페이스를 공유하는 것은 awsvpc 뿐이다. bridge 로
    // 바꾸면 collector 의 localhost 는 자기 자신을 가리키고 거기엔 아무도 없다.
    // **그리고 그 실패는 조용하다 - synth 도 test 도 deploy 도 전부 통과하고 런타임
    // connection refused 로만 드러나며 collector 는 배치를 무한 재시도한다.**
    // 그래서 이 한 줄이 방어선이다. (ADR-0004, ADR-0017, ADR-0022 4번)
    test('collector 태스크는 awsvpc 다 - localhost:8080 계약과 한 몸이다', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        NetworkMode: 'awsvpc',
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'otel-collector' }),
          Match.objectLike({ Name: 'post-processor' }),
        ]),
      });
    });

    // **bridge 여야 한다.** api-server 와 batch-processor 사이에는 localhost 의존이
    // 없고, bridge 태스크는 호스트 ENI 를 타므로 퍼블릭 IP 를 통해 인터넷 egress 가
    // 살아난다(NAT 가 없는 이 VPC 에서 유일한 경로다). awsvpc 로 바꾸면 두 컨테이너가
    // 이미지 pull 외의 외부 호출을 전부 잃는다. 그리고 ALB 타깃 타입이 instance 인
    // 것도 이 모드의 결과이므로 DevEdgeStack 이 함께 깨진다. (ADR-0022 4번/8번)
    test('dashboard 태스크는 bridge 다 - 호스트 ENI egress 와 instance 타깃의 전제다', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        NetworkMode: 'bridge',
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'api-server' }),
          Match.objectLike({ Name: 'batch-processor' }),
        ]),
      });
    });

    // **awsvpc 여야 한다.** Cloud Map 에 A 레코드(clickhouse.obs.local)를 등록하려면
    // 태스크에 전용 IP 가 있어야 한다. bridge/host 모드에서는 Cloud Map 이 SRV
    // 레코드만 등록하고, SRV 는 일반 HTTP 클라이언트가 해석하지 못한다. 그러면
    // ENRICHMENT_CH_URL 계약이 dev 에서만 깨지고, 앱은 이름이 안 풀리면 예외 없이
    // compose 기본값으로 조용히 폴백하므로 증상은 "컨테이너는 RUNNING 인데 모든
    // 적재가 503"이다. (ADR-0005, ADR-0018, ADR-0022 4번)
    test('clickhouse 태스크는 awsvpc 다 - Cloud Map A 레코드의 전제다', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        NetworkMode: 'awsvpc',
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'clickhouse' }),
        ]),
      });
    });

    // **bridge 여도 된다.** ADR-0022 4번이 awsvpc 를 강제하는 조건은 둘뿐인데
    // (태스크 내 localhost 의존 / Cloud Map A 레코드 등록 대상) auth-proxy 는 둘 다
    // 아니다 - 단일 컨테이너이고 디스커버리의 클라이언트다. awsvpc 로 바꾸면 호스트
    // ENI 가 3/3 이 되어 이후 awsvpc 태스크에 awsvpcTrunking 옵트인이 필요해지고,
    // 태스크가 인터넷 egress 를 잃으며(ADR-0008 의 JWKS 검증이 들어올 때 조용히
    // 타임아웃), ALB 타깃 타입이 ip 로 바뀌어 DevEdgeStack 이 함께 깨진다.
    // (ADR-0022 4번/5(a)/11번, ADR-0023 2번)
    test('auth-proxy 태스크는 bridge 다 - ENI 여유와 egress 의 전제다', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        NetworkMode: 'bridge',
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'auth-proxy' }),
        ]),
      });
    });
  });

  // ============================================================
  // auth-proxy 런타임 계약 (ADR-0023)
  // ============================================================
  describe('auth-proxy 런타임 계약', () => {
    /** auth-proxy 컨테이너 정의 하나를 집는다. */
    function authProxyContainer(): any {
      const found = Object.values(
        template.findResources('AWS::ECS::TaskDefinition'),
      )
        .flatMap((resource: any) => resource.Properties.ContainerDefinitions)
        .filter((definition: any) => definition.Name === 'auth-proxy');

      expect(found).toHaveLength(1);
      return found[0];
    }

    // **이름은 앱 소스(apps/auth-proxy/src/config/env.ts)가 권위다.** 이 앱은 필수
    // 값이 비면 즉시 throw 하며 기동에 실패하므로 오타가 재시작 루프로 드러나긴
    // 하지만, 그 진단을 배포 후로 미룰 이유가 없다.
    test('앱이 읽는 이름 그대로 환경변수와 시크릿을 주입한다', () => {
      const container = authProxyContainer();

      const envNames = container.Environment.map((entry: any) => entry.Name);
      expect(envNames.sort()).toEqual(
        ['COLLECTOR_BASE_URL', 'LOG_LEVEL'].sort(),
      );

      const secretNames = container.Secrets.map((entry: any) => entry.Name);
      expect(secretNames.sort()).toEqual(
        ['DATABASE_URL', 'TOKEN_HASH_SECRET'].sort(),
      );
    });

    // **끝에 슬래시가 붙으면 앱이 `//v1/traces` 를 만든다.** 앱의 env.ts 가 잘라주긴
    // 하지만 그 방어에 기대지 않는다. 주소가 틀리면 ALB 헬스체크(/health)는 계속
    // 통과하고 실제 전달만 upstream_unreachable 로 죽는다.
    test('COLLECTOR_BASE_URL 은 Cloud Map 주소이고 끝 슬래시가 없다', () => {
      const value = authProxyContainer().Environment.find(
        (entry: any) => entry.Name === 'COLLECTOR_BASE_URL',
      ).Value;

      expect(value).toBe(COLLECTOR_OTLP_URL);
      expect(value).toBe(`http://collector.obs.local:${PORTS.otlp}`);
      expect(value.endsWith('/')).toBe(false);
    });

    // DATABASE_URL 에는 DB 비밀번호가, TOKEN_HASH_SECRET 은 그 자체가 비밀이다.
    // environment 로 새면 `aws ecs describe-task-definition` 에 평문으로 드러난다.
    test('비밀 값은 environment 가 아니라 secrets 로만 들어간다', () => {
      const serialized = JSON.stringify(authProxyContainer().Environment);

      expect(serialized).not.toContain('DATABASE_URL');
      expect(serialized).not.toContain('TOKEN_HASH_SECRET');
      expect(serialized).not.toContain('resolve:secretsmanager');
    });

    // **auth-proxy 가 collector 를 찾는 유일한 수단이다.** A 레코드여야 하며
    // (bridge/host 면 Cloud Map 이 SRV 만 등록한다) collector 태스크가 awsvpc 인
    // 것이 그 전제다. 이 등록이 빠지면 이름이 안 풀려 전달이 전부 실패한다.
    // (ADR-0005, ADR-0023 1번)
    test('collector 서비스가 Cloud Map 에 A 레코드로 등록된다', () => {
      template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
        Name: COLLECTOR_SERVICE_NAME,
        DnsConfig: Match.objectLike({
          DnsRecords: [Match.objectLike({ Type: 'A' })],
        }),
      });
    });
  });

  // ============================================================
  // 로그 그룹 이름 (ADR-0021 Constraints, ADR-0022 10번)
  // ============================================================
  describe('로그 그룹 이름', () => {
    /** ASG drain hook Lambda 로그 그룹은 Fn::Join 이므로 리터럴만 고른다. */
    const ecsLogGroupNames = (): string[] =>
      Object.values(template.findResources('AWS::Logs::LogGroup'))
        .map((resource: any) => resource.Properties.LogGroupName)
        .filter((name): name is string => typeof name === 'string');

    // 접두사를 빼면 첫 cdk deploy 가 `already exists` 로 통째로 롤백된다 - 로그 그룹
    // 이름은 계정 + 리전 스코프에서 유일하고 운영이 이미 /ecs/collector 를 쓴다.
    test('컨테이너 로그 그룹 6개가 전부 /ecs/dev/ 접두사를 쓴다', () => {
      const names = ecsLogGroupNames();

      expect(names).toHaveLength(6);
      expect(names.sort()).toEqual(
        [
          `${DEV_LOG_GROUP_PREFIX}/collector`,
          `${DEV_LOG_GROUP_PREFIX}/post-processor`,
          `${DEV_LOG_GROUP_PREFIX}/auth-proxy`,
          `${DEV_LOG_GROUP_PREFIX}/api-server`,
          `${DEV_LOG_GROUP_PREFIX}/batch`,
          `${DEV_LOG_GROUP_PREFIX}/clickhouse`,
        ].sort(),
      );
      for (const name of names) {
        expect(name).toMatch(/^\/ecs\/dev\//);
      }
    });

    // 위 어서션의 뒷면. 운영 이름이 하나라도 남아 있으면 그 로그 그룹에서 첫 배포가
    // 실패한다.
    test('운영 로그 그룹 이름을 하나도 쓰지 않는다', () => {
      const names = ecsLogGroupNames();
      for (const prodName of [
        '/ecs/collector',
        '/ecs/post-processor',
        '/ecs/api-server',
        '/ecs/batch',
        '/ecs/clickhouse',
      ]) {
        expect(names).not.toContain(prodName);
      }
    });
  });

  // ============================================================
  // post-processor 런타임 계약 (ADR-0018)
  // ============================================================
  describe('post-processor 런타임 계약', () => {
    // 앱이 os.environ 으로 읽는 이름 그대로여야 한다. 하나라도 틀리면 앱은 예외를
    // 던지지 않고 compose 전용 기본값으로 폴백하고, ECS 에서는 그 호스트명이 안 풀려
    // 모든 insert 가 503 이 된다. 운영과 같은 값이어야 계약이 갈라지지 않는다.
    test('앱이 읽는 3개 값을 정확한 이름으로 준다', () => {
      expect(envMap('post-processor')[ENRICHMENT_ENV.clickhouseUrl]).toBe(
        CLICKHOUSE_HTTP_URL,
      );
      expect(envMap('post-processor')[ENRICHMENT_ENV.clickhouseUrl]).toBe(
        'http://clickhouse.obs.local:8123',
      );
      expect(envMap('post-processor')[ENRICHMENT_ENV.clickhouseDb]).toBe(
        CLICKHOUSE_DEFAULT_DB,
      );
      expect(secretNames('post-processor')).toContain(ENRICHMENT_ENV.pgDsn);
    });

    // ADR-0017 의 awss3 exporter 전환 대비. env 와 task role 의 S3 권한은 한 몸이다.
    test('RAW_BUCKET 을 준다', () => {
      expect(Object.keys(envMap('post-processor'))).toContain('RAW_BUCKET');
    });

    // DSN 에는 비밀번호가 통째로 들어 있다. environment 로 새면 콘솔에 평문이 남는다.
    test('ENRICHMENT_PG_DSN 은 environment 가 아니라 secrets 로만 준다', () => {
      expect(Object.keys(envMap('post-processor'))).not.toContain(
        ENRICHMENT_ENV.pgDsn,
      );

      const entry = (container('post-processor').Secrets ?? []).find(
        (secret: any) => secret.Name === ENRICHMENT_ENV.pgDsn,
      );
      expect(entry.ValueFrom).toBeDefined();
      expect(JSON.stringify(entry.ValueFrom)).not.toMatch(/password=/);
    });

    // 앱이 읽지 않는 이름을 남겨두면 "설정했으니 되겠지"라는 착시가 다시 생긴다.
    // 운영에서 실제로 이 죽은 계약 때문에 깨졌고, dev 가 그걸 되살리면 안 된다.
    test('앱이 읽지 않는 죽은 계약을 남기지 않는다', () => {
      const names = [
        ...Object.keys(envMap('post-processor')),
        ...secretNames('post-processor'),
      ];
      for (const dead of ['DB_CREDS', 'DB_NAME', 'CLICKHOUSE_HOST']) {
        expect(names).not.toContain(dead);
      }
    });
  });

  // ============================================================
  // otel-collector 컨테이너 (ADR-0017)
  // ============================================================
  describe('otel-collector 컨테이너', () => {
    test('env provider 로 config 를 읽도록 command 를 덮어쓴다', () => {
      expect(container('otel-collector').Command).toEqual([
        '--config=env:OTEL_CONFIG',
      ]);
      expect(Object.keys(envMap('otel-collector'))).toContain('OTEL_CONFIG');
    });

    // 이 이미지는 User=10001:10001 이고 UID 10001 이 쓸 수 있는 디렉터리가 하나도
    // 없다(scratch 기반이라 /tmp 도 없다). config 의 file exporter 가 /data 를
    // 만들려면 root 가 필요하고, 빼면 `mkdir /data: permission denied` 로 기동 직후
    // exit 1 이다. **user: '0' 과 file exporter 는 한 몸이라 함께 없애야 한다.**
    // 운영 최초 배포가 정확히 이것 때문에 죽었다. (ADR-0017)
    test('root 로 실행한다 - file exporter 와 한 몸이다', () => {
      expect(container('otel-collector').User).toBe('0');
    });

    // root 범위를 collector 한 컨테이너로 한정한다.
    test('root 실행은 collector 에만 적용한다', () => {
      expect(container('post-processor').User).toBeUndefined();
    });
  });

  // batch 실패가 api-server 태스크를 통째로 내리지 않게 한다. (ADR-0004)
  test('batch-processor 는 non-essential 이다', () => {
    expect(container('batch-processor').Essential).toBe(false);
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
    // post-processor 의 모든 적재가 403(Authentication failed)으로 죽는다.**
    // 앱이 그걸 BackendUnavailable 로 감싸 리시버가 503 을 뱉으며, synth 도 test 도
    // deploy 도 전부 통과한다 - 운영에서 실제로 이렇게 깨졌다. (ADR-0019)
    test('CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT 가 1 이다', () => {
      expect(envMap('clickhouse').CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT).toBe(
        '1',
      );
    });

    // 서버가 만드는 DB 와 post-processor 의 ENRICHMENT_CH_DB 가 갈라지면 적재 대상
    // 테이블이 서로 다른 DB 에 생긴다.
    test('컨테이너 DB 이름은 post-processor 가 쓰는 DB 와 같다', () => {
      expect(envMap('clickhouse').CLICKHOUSE_DB).toBe(CLICKHOUSE_DEFAULT_DB);
    });
  });

  // ============================================================
  // ECR 이미지 (ADR-0007, ADR-0021 5번)
  // ============================================================
  describe('자체 빌드 이미지', () => {
    const ownBuilt: ReadonlyArray<readonly [string, string]> = [
      ['post-processor', ECR_REPOS.postProcessor],
      ['auth-proxy', ECR_REPOS.authProxy],
      ['api-server', ECR_REPOS.apiServer],
      ['batch-processor', ECR_REPOS.batchProcessor],
    ];

    /**
     * fromEcrRepository 는 Image 를 계정/리전 조각과 레포 이름의 Fn::Join 으로
     * 만든다. URLSuffix 같은 Ref 조각을 빼고 리터럴만 이어붙인다.
     */
    const imageLiterals = (containerName: string): string =>
      (container(containerName).Image['Fn::Join'][1] as unknown[])
        .filter((part): part is string => typeof part === 'string')
        .join('');

    test('세 이미지 모두 soma-376 네임스페이스의 ECR 레포를 가리킨다', () => {
      for (const [containerName, repositoryName] of ownBuilt) {
        expect(repositoryName.startsWith(`${ECR_NAMESPACE}/`)).toBe(true);
        expect(imageLiterals(containerName)).toContain(`/${repositoryName}:`);
      }
    });

    // dev/prod 가 같은 레포를 공유하고 태그로만 갈린다. 태그가 URI 에 실제로 붙는지
    // 확인하지 않으면 devImageTag 손잡이 전체가 무의미해진다. (ADR-0021 5번)
    // **`:latest` 로 되돌아가면 안 된다.** 운영도 태그 없이 `latest` 를 읽던 시절에는
    // dev 빌드가 곧 운영 이미지였다. ADR-0024 가 두 환경에 서로 다른 고정 태그를 줘서
    // 그 경로를 닫았고, 여기가 그 회귀를 잡는 자리다.
    test('devImageTag 미지정이면 :dev 가 붙는다', () => {
      for (const [containerName, repositoryName] of ownBuilt) {
        expect(imageLiterals(containerName)).toContain(`/${repositoryName}:dev`);
        expect(imageLiterals(containerName)).not.toContain(':latest');
      }
    });

    // 운영 태그를 dev 가 읽으면 두 환경이 다시 같은 이미지를 보게 된다.
    test('dev 이미지에 운영 태그가 붙지 않는다', () => {
      for (const [containerName] of ownBuilt) {
        expect(imageLiterals(containerName)).not.toContain(
          `:${PROD_IMAGE_TAG}`,
        );
      }
    });
  });

  test('devImageTag 를 주면 그 태그가 이미지 URI 에 붙는다', () => {
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

    // post-processor, auth-proxy, api-server, batch-processor. collector 와
    // clickhouse 는 퍼블릭 레지스트리라 Fn::Join 이 아니다.
    expect(ecrImages).toHaveLength(4);
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

    // 호스트가 1대뿐이고 awsvpc 태스크가 ENI 를 잡으므로 "새 태스크를 먼저 띄울"
    // 여유가 없다. minHealthyPercent 를 올리면 배포가 영원히 끝나지 않는다.
    test('네 서비스 모두 교체 배포(0/100, desired 1)로 고정한다', () => {
      expect(services()).toHaveLength(4);
      for (const service of services()) {
        expect(service.Properties.DesiredCount).toBe(1);
        expect(service.Properties.DeploymentConfiguration).toMatchObject({
          MinimumHealthyPercent: 0,
          MaximumPercent: 100,
        });
      }
    });

    // awsvpc 태스크는 ssmmessages 에 도달할 경로가 없어(NAT 도 인터페이스
    // 엔드포인트도 없다) ECS Exec 이 어차피 동작하지 않으면서 태스크 역할에 권한만
    // 붙는다. 접속 경로는 호스트 SSM + `docker exec` 이다. (ADR-0022 5(b), ADR-0016)
    test('세 서비스 모두 ECS Exec 을 켜지 않는다', () => {
      for (const service of services()) {
        expect(service.Properties.EnableExecuteCommand).toBeUndefined();
      }
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

    test('앱 ASG 의 최대 용량 기본값은 1 이다', () => {
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
    // ENRICHMENT_CH_URL 이 dev 에서만 조용히 깨진다. 위 clickhouse 태스크의
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
