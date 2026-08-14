import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  AutoScalingGroup,
  BlockDevice,
  BlockDeviceVolume,
  EbsDeviceVolumeType,
} from 'aws-cdk-lib/aws-autoscaling';
import {
  InstanceType,
  ISecurityGroup,
  IVpc,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import {
  AmiHardwareType,
  AsgCapacityProvider,
  Cluster,
  ContainerImage,
  Ec2Service,
  Ec2TaskDefinition,
  EcsOptimizedImage,
  LogDriver,
  NetworkMode,
  PropagatedTagSource,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import {
  DnsRecordType,
  PrivateDnsNamespace,
} from 'aws-cdk-lib/aws-servicediscovery';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  CLICKHOUSE_CONTAINER_ENV,
  CLICKHOUSE_DEFAULT_DB,
  CLICKHOUSE_HOST,
  CLICKHOUSE_HTTP_URL,
  CLICKHOUSE_IMAGE,
  CLICKHOUSE_SERVICE_NAME,
  CLOUD_MAP_NAMESPACE,
  CONTROL_DB_NAME,
  ECR_REPOS,
  ENRICHMENT_ENV,
  PORTS,
} from '../common/config';
import { clickhouseUserData } from '../common/clickhouse-user-data';
import {
  DevConfig,
  DEV_APP_INSTANCE_TYPE,
  DEV_CLICKHOUSE_DATA_VOLUME_GIB,
  DEV_CLICKHOUSE_INSTANCE_TYPE,
  DEV_LOG_GROUP_PREFIX,
} from './config';

/**
 * Collector config 파일 경로. 소비처가 이 파일과 운영 스택 둘뿐이라 `config.ts` 가
 * 아니라 여기 둔다(운영 `lib/prod/application-stack.ts` 와 같은 판단).
 *
 * **운영과 같은 파일을 읽는다.** dev 전용으로 포크하면 collector 동작이 갈라져
 * dev 에서 검증한 파이프라인이 운영을 보장하지 못한다. (ADR-0022 4번)
 * 깊이는 `lib/dev/` -> `lib/` -> 레포 루트로 두 단계다.
 */
const COLLECTOR_CONFIG_PATH = join(
  __dirname,
  '..',
  '..',
  'config',
  'otel-collector.yaml',
);

/** Collector 가 config 를 읽어갈 환경변수 이름. `--config=env:<이름>` 과 짝이다. */
const COLLECTOR_CONFIG_ENV = 'OTEL_CONFIG';

/** 컨테이너 소프트 메모리 예약(MiB). EC2 launch type 이므로 하드 리밋은 두지 않는다. */
const MEMORY_RESERVATION_MIB = {
  collector: 256,
  postProcessor: 512,
  apiServer: 1024,
  batchProcessor: 256,
  clickhouse: 1024,
} as const;

/**
 * 세 서비스 공통 배포 전략: 먼저 내리고 새로 띄우는 **교체 배포**.
 *
 * t4g 계열의 인스턴스당 ENI 한도는 프라이머리 포함 3 이고 awsvpc 태스크는 태스크당
 * ENI 를 하나 잡는다. 호스트가 1대뿐이므로 롤링 배포에 필요한 "새 태스크를 먼저
 * 띄울" 여유가 없다. `minHealthyPercent` 를 올리면 배포가 영원히 끝나지 않는다.
 * 교체 중에는 짧은 다운타임이 발생하며, 이는 감수한 대가다.
 *
 * 운영 ClickHouse `Ec2Service` 와 정확히 같은 패턴이다.
 * (`AGENTS.md` 3장 불변 규칙, ADR-0022 Constraints)
 */
const REPLACEMENT_DEPLOYMENT = {
  minHealthyPercent: 0,
  maxHealthyPercent: 100,
} as const;

export interface DevApplicationStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly devConfig: DevConfig;
  /** api-server 의 DB_CREDS 용 RDS 마스터 시크릿. */
  readonly dbSecret: ISecret;
  /** post-processor 의 ENRICHMENT_PG_DSN 용 파생 시크릿. (ADR-0018) */
  readonly postProcessorPgDsnSecret: ISecret;
  readonly rawSignalBucket: IBucket;
  /** EC2 호스트 2대 공용 SG. ASG 에 붙는다. */
  readonly appHostSecurityGroup: ISecurityGroup;
  /** collector 태스크 ENI(awsvpc)용 SG. */
  readonly collectorSecurityGroup: ISecurityGroup;
  /** ClickHouse 태스크 ENI(awsvpc)용 SG. */
  readonly clickhouseSecurityGroup: ISecurityGroup;
}

/**
 * DevApplicationStack: ECS 클러스터(단일), Cloud Map `obs.local`,
 * ASG 2개 + 캐패시티 프로바이더 2개, Ec2Service 3개.
 *
 * 운영과의 차이는 **launch type 과 네트워크 모드뿐**이다. 컨테이너 정의·환경변수·
 * 시크릿 주입은 운영과 100% 같은 계약을 재현한다 - 계약이 갈리면 "dev 에서
 * 검증했다"는 말의 의미가 사라진다. (ADR-0021 2번)
 *
 * 세 태스크가 서로 다른 이유로 서로 다른 네트워크 모드를 요구한다. 각 태스크
 * 빌더의 주석에 그 이유가 있다. (ADR-0022 4번)
 */
export class DevApplicationStack extends Stack {
  public readonly cluster: Cluster;
  public readonly collectorService: Ec2Service;
  public readonly dashboardService: Ec2Service;
  public readonly clickhouseService: Ec2Service;

  private readonly namespace: PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: DevApplicationStackProps) {
    super(scope, id, props);

    this.cluster = new Cluster(this, 'DevCluster', {
      vpc: props.vpc,
    });

    // 네임스페이스 이름은 운영과 **같은 `obs.local`** 이다. private DNS
    // 네임스페이스는 VPC 스코프라 같은 계정에 동명이 둘 있어도 충돌하지 않고,
    // 각각 자신이 연결된 VPC 안에서만 해석된다.
    //
    // 이름을 맞추는 것은 우연한 편의가 아니라 의도한 결과다 -
    // `CLICKHOUSE_HTTP_URL = http://clickhouse.obs.local:8123` 이 dev 와 prod 에서
    // 한 값으로 유지되어야 `ENRICHMENT_CH_URL` 계약이 갈라지지 않는다.
    // (ADR-0005, ADR-0021 5번)
    this.namespace = new PrivateDnsNamespace(this, 'DevNamespace', {
      name: CLOUD_MAP_NAMESPACE,
      vpc: props.vpc,
    });

    const appCapacityProvider = this.buildAppAsg(props);
    const clickhouseCapacityProvider = this.buildClickhouseAsg(props);

    this.collectorService = this.buildCollectorService(
      props,
      appCapacityProvider,
    );
    this.dashboardService = this.buildDashboardService(
      props,
      appCapacityProvider,
    );
    this.clickhouseService = this.buildClickhouseService(
      props,
      clickhouseCapacityProvider,
    );
  }

  /**
   * 로그 그룹. 이름만 `/ecs/dev/` 접두를 붙이고 basename·보존 기간·삭제 정책은
   * 운영과 같다. 접두사를 빼면 첫 배포가 `already exists` 로 실패한다.
   * (ADR-0021 Constraints, ADR-0022 10번)
   */
  private makeLogGroup(id: string, basename: string): LogGroup {
    return new LogGroup(this, id, {
      logGroupName: `${DEV_LOG_GROUP_PREFIX}/${basename}`,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /**
   * ECS on EC2 호스트 ASG 의 공통 설정.
   *
   * `associatePublicIpAddress: true` 는 **NAT 가 없으므로 필수다.** ECS agent 가
   * ECS API 에 도달하지 못하면 인스턴스가 클러스터에 등록조차 되지 않아 태스크가
   * 영원히 PROVISIONING 에 머문다. 이미지 pull, CloudWatch Logs 전송,
   * Secrets Manager 조회도 전부 이 호스트 ENI 를 경유한다. (ADR-0022 5(a))
   */
  private makeHostAsg(
    id: string,
    props: DevApplicationStackProps,
    options: {
      readonly instanceType: InstanceType;
      readonly maxCapacity: number;
      readonly blockDevices?: BlockDevice[];
    },
  ): AutoScalingGroup {
    const asg = new AutoScalingGroup(this, id, {
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      instanceType: options.instanceType,
      // ARM64 로 고정한다. t4g 는 Graviton 이고, 운영과 같은 이미지를 쓰는 것이
      // 목적이다 - dev 가 x86 이면 앱 레포가 두 아키텍처를 빌드해야 한다.
      // (ADR-0015, ADR-0022 3번)
      machineImage: EcsOptimizedImage.amazonLinux2023(AmiHardwareType.ARM),
      minCapacity: 1,
      maxCapacity: options.maxCapacity,
      // desiredCapacity 를 주지 않는다. 주면 CDK 가 매 배포마다 그 값으로 되돌려
      // 수동 스케일 조정이 다음 deploy 에 덮인다.
      requireImdsv2: true,
      associatePublicIpAddress: true,
      securityGroup: props.appHostSecurityGroup,
      blockDevices: options.blockDevices,
    });

    // 호스트 SSM 접속이 dev 디버깅의 주 경로다. awsvpc 태스크에서는 ECS Exec 이
    // 동작하지 않으므로(ADR-0022 5(b)), 호스트에 Session Manager 로 붙어
    // `sudo docker exec` 하는 것이 **모든** 컨테이너에 들어가는 유일한 방법이다.
    // 접근 통제의 실체는 운영자 IAM 의 `ssm:StartSession` 이며 이 레포 밖이다.
    // (ADR-0016)
    asg.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    return asg;
  }

  /**
   * 캐패시티 프로바이더 등록.
   *
   * `enableManagedTerminationProtection: false` 는 운영에서 계승한 불변 규칙이다 -
   * 관리형 종료 보호가 단일 인스턴스 교체 배포를 막는다.
   * (`AGENTS.md` 3장, ADR-0022 Constraints)
   *
   * `machineImageType` 은 지정하지 않는다. 기본값 `AMAZON_LINUX_2` 가 ECS 최적화
   * AL2023 AMI 를 포함하는 분류이고(Bottlerocket 과 구분하는 값이다), 운영
   * `ClickhouseCapacityProvider` 도 같은 이유로 생략한다.
   */
  private addCapacityProvider(
    id: string,
    asg: AutoScalingGroup,
  ): AsgCapacityProvider {
    const capacityProvider = new AsgCapacityProvider(this, id, {
      autoScalingGroup: asg,
      enableManagedTerminationProtection: false,
    });
    this.cluster.addAsgCapacityProvider(capacityProvider);
    return capacityProvider;
  }

  // ============================================================
  // ASG ① : 앱 호스트 (collector 태스크 + dashboard 태스크)
  // ============================================================
  private buildAppAsg(props: DevApplicationStackProps): AsgCapacityProvider {
    // 루트 볼륨은 AMI 기본(gp3 30GB)을 그대로 쓴다. 추가 데이터 볼륨이 없다.
    const asg = this.makeHostAsg('DevAppAsg', props, {
      instanceType: DEV_APP_INSTANCE_TYPE,
      // 부하 테스트 확장 손잡이. `-c devAppAsgMaxCapacity=N` (ADR-0022 11번).
      maxCapacity: props.devConfig.appAsgMaxCapacity,
    });
    return this.addCapacityProvider('DevAppCapacityProvider', asg);
  }

  // ============================================================
  // ASG ② : ClickHouse 호스트
  // ============================================================
  private buildClickhouseAsg(
    props: DevApplicationStackProps,
  ): AsgCapacityProvider {
    const asg = this.makeHostAsg('DevClickhouseAsg', props, {
      instanceType: DEV_CLICKHOUSE_INSTANCE_TYPE,
      // ClickHouse 태스크는 호스트 볼륨에 묶여 있어 다중화가 의미 없다.
      maxCapacity: 1,
      blockDevices: [
        {
          deviceName: '/dev/xvdb', // ClickHouse 데이터
          volume: BlockDeviceVolume.ebs(DEV_CLICKHOUSE_DATA_VOLUME_GIB, {
            volumeType: EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // xvdb 포맷 + /data/clickhouse 마운트. 운영과 **같은 함수**를 쓴다
    // (`lib/common/clickhouse-user-data.ts`) - 스크립트가 갈리면 데이터 디렉터리
    // 레이아웃이 환경마다 달라진다. (ADR-0021 2번)
    asg.addUserData(...clickhouseUserData());

    return this.addCapacityProvider('DevClickhouseCapacityProvider', asg);
  }

  // ============================================================
  // 태스크 ① : Collector & Post Processor - awsvpc
  // ============================================================
  private buildCollectorService(
    props: DevApplicationStackProps,
    capacityProvider: AsgCapacityProvider,
  ): Ec2Service {
    const task = new Ec2TaskDefinition(this, 'DevCollectorTask', {
      // **awsvpc 여야 한다.** `config/otel-collector.yaml` 의 exporter 가
      // `http://localhost:8080` 으로 같은 태스크의 post-processor 를 부르는데,
      // 태스크 내 컨테이너가 네트워크 네임스페이스를 공유하는 것은 awsvpc 뿐이다.
      // bridge 로 바꾸면 collector 의 localhost 는 자기 자신을 가리키고 거기엔
      // 아무도 없다. **그리고 이 실패는 조용하다 - synth 도 test 도 deploy 도
      // 전부 통과하고 런타임 connection refused 로만 드러나며, collector 는 그
      // 배치를 무한히 재시도한다.** (ADR-0004, ADR-0017, ADR-0022 4번)
      networkMode: NetworkMode.AWS_VPC,
    });

    // 애플리케이션 런타임에 필요한 S3 권한만 task role 에 부여한다.
    props.rawSignalBucket.grantReadWrite(task.taskRole);

    task.addContainer('otel-collector', {
      image: ContainerImage.fromRegistry(
        'otel/opentelemetry-collector-contrib',
      ),
      // 이 이미지는 User=10001:10001 로 도는데, config 의 file exporter 가
      // /data 를 만들려면 루트 파일시스템에 써야 한다. 이미지에 UID 10001 이
      // 쓸 수 있는 디렉터리가 하나도 없어서(scratch 기반이라 /tmp 도 없다)
      // root 로 실행한다. 빼면 `mkdir /data: permission denied` 로 기동 직후
      // exit 1 이다. file exporter 와 한 몸이라 함께 없애야 한다. (ADR-0017)
      user: '0',
      // 이미지의 ENTRYPOINT(/otelcol-contrib)는 유지되고 CMD 만 대체된다.
      command: [`--config=env:${COLLECTOR_CONFIG_ENV}`],
      environment: {
        // config 본문 전체를 환경변수로 넘긴다. 이 값은 CloudFormation 템플릿과
        // ECS 콘솔에 평문으로 남으므로 config 에 시크릿을 넣으면 안 된다.
        [COLLECTOR_CONFIG_ENV]: readFileSync(COLLECTOR_CONFIG_PATH, 'utf8'),
      },
      memoryReservationMiB: MEMORY_RESERVATION_MIB.collector,
      portMappings: [{ containerPort: PORTS.otlp }],
      logging: LogDriver.awsLogs({
        streamPrefix: 'otel-collector',
        logGroup: this.makeLogGroup('DevCollectorLog', 'collector'),
      }),
    });

    task.addContainer('post-processor', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'DevPostProcessorRepo',
          ECR_REPOS.postProcessor,
        ),
        props.devConfig.imageTag,
      ),
      // 이 이름들은 앱 소스(ai-telemetry-pipeline)가 권위다. 앱이 os.environ 으로
      // 읽는 이름과 한 글자라도 다르면 조용히 compose 전용 기본값으로 폴백하고,
      // ECS 에서는 DNS 가 안 풀려 모든 insert 가 503 이 된다. **죽은 계약
      // (`CLICKHOUSE_HOST`·`DB_CREDS`·`DB_NAME`)을 여기 다시 넣지 않는다.**
      // (`AGENTS.md` 3장, ADR-0018)
      environment: {
        [ENRICHMENT_ENV.clickhouseUrl]: CLICKHOUSE_HTTP_URL,
        [ENRICHMENT_ENV.clickhouseDb]: CLICKHOUSE_DEFAULT_DB,
        // 앱은 아직 이 값을 읽지 않는다. ADR-0017 이 예고한 collector 의 awss3
        // exporter 전환에 대비해 위 grantReadWrite 와 함께 의도적으로 남겨둔다.
        RAW_BUCKET: props.rawSignalBucket.bucketName,
      },
      // DSN 에는 DB 비밀번호가 통째로 들어 있으므로 environment 가 아니라 secrets 로
      // 넣는다. addContainer 가 execution role 에 grantRead 를 자동으로 붙인다.
      // (ADR-0018)
      secrets: {
        [ENRICHMENT_ENV.pgDsn]: EcsSecret.fromSecretsManager(
          props.postProcessorPgDsnSecret,
        ),
      },
      memoryReservationMiB: MEMORY_RESERVATION_MIB.postProcessor,
      // awsvpc 에서 기능상 필수는 아니지만, collector 가 localhost 의 이 포트로
      // OTLP 를 밀어넣는다는 계약을 태스크 정의에 남긴다. (ADR-0017)
      portMappings: [{ containerPort: PORTS.postProcessor }],
      logging: LogDriver.awsLogs({
        streamPrefix: 'post-processor',
        logGroup: this.makeLogGroup('DevPostProcessorLog', 'post-processor'),
      }),
    });

    return new Ec2Service(this, 'DevCollectorService', {
      cluster: this.cluster,
      taskDefinition: task,
      desiredCount: 1,
      // awsvpc 태스크만 태스크 ENI 를 받으므로 여기에만 SG/서브넷을 준다.
      // `assignPublicIp` 는 **EC2 launch type 에 존재하지 않는다** - 퍼블릭 IP
      // 할당은 launch template 의 인스턴스 ENI 설정이지 태스크 ENI 설정이 아니다.
      // 그래서 이 태스크에는 인터넷 egress 가 없다. (ADR-0022 5(a))
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [props.collectorSecurityGroup],
      capacityProviderStrategies: [
        { capacityProvider: capacityProvider.capacityProviderName, weight: 1 },
      ],
      propagateTags: PropagatedTagSource.SERVICE,
      ...REPLACEMENT_DEPLOYMENT,
      // enableExecuteCommand 를 켜지 않는다. awsvpc 태스크는 ssmmessages 에 도달할
      // 경로가 없어 어차피 동작하지 않으면서 태스크 역할에 권한만 붙는다.
      // 접속은 호스트 SSM + `docker exec` 이다. (ADR-0022 5(b), ADR-0016)
    });
  }

  // ============================================================
  // 태스크 ② : Dashboard Backend - bridge
  // ============================================================
  private buildDashboardService(
    props: DevApplicationStackProps,
    capacityProvider: AsgCapacityProvider,
  ): Ec2Service {
    const task = new Ec2TaskDefinition(this, 'DevDashboardTask', {
      // **bridge 로 둘 수 있다.** api-server 와 batch-processor 사이에는 localhost
      // 의존이 없다 - 인프라가 주입하는 값(DB_CREDS/DB_NAME, CLICKHOUSE_HOST)이
      // 전부 태스크 밖을 향한다. bridge 태스크는 호스트 ENI 를 타므로 퍼블릭 IP 를
      // 통해 **인터넷 egress 와 ECS Exec 이 살아난다.** 두 컨테이너는 소스를
      // 확보하지 못한 것들이라(`AGENTS.md` 3장) 관측 수단을 줄일 이유가 없다.
      //
      // 다만 이 전제는 추정이다. 배포 후 로그로 확인하고 틀렸다면 awsvpc 로
      // 전환한다 - 그 경우 egress 와 Exec 을 함께 잃는다. (ADR-0022 4번/Follow-up)
      networkMode: NetworkMode.BRIDGE,
    });

    task.addContainer('api-server', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'DevApiServerRepo',
          ECR_REPOS.apiServer,
        ),
        props.devConfig.imageTag,
      ),
      // hostPort 를 주지 않아 **동적 포트**를 쓴다. 포트 충돌 없이 같은 호스트에
      // 여러 개를 띄울 수 있고, ALB 인스턴스 타깃이 동적 포트 등록을 자동으로
      // 처리한다. `DevAppHostSg` 의 32768-65535 룰이 이것과 한 몸이다.
      portMappings: [{ containerPort: PORTS.apiServer }],
      environment: {
        // DB_CREDS 시크릿에는 dbname 이 없다. DB 이름은 여기서만 전달한다.
        DB_NAME: CONTROL_DB_NAME,
      },
      secrets: {
        DB_CREDS: EcsSecret.fromSecretsManager(props.dbSecret),
      },
      memoryReservationMiB: MEMORY_RESERVATION_MIB.apiServer,
      logging: LogDriver.awsLogs({
        streamPrefix: 'api-server',
        logGroup: this.makeLogGroup('DevApiServerLog', 'api-server'),
      }),
    });

    task.addContainer('batch-processor', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'DevBatchRepo',
          ECR_REPOS.batchProcessor,
        ),
        props.devConfig.imageTag,
      ),
      essential: false, // 배치 실패가 api-server 태스크를 내리지 않게 함 (ADR-0004)
      environment: {
        CLICKHOUSE_HOST: CLICKHOUSE_HOST,
      },
      memoryReservationMiB: MEMORY_RESERVATION_MIB.batchProcessor,
      logging: LogDriver.awsLogs({
        streamPrefix: 'batch-processor',
        logGroup: this.makeLogGroup('DevBatchLog', 'batch'),
      }),
    });

    return new Ec2Service(this, 'DevDashboardService', {
      cluster: this.cluster,
      taskDefinition: task,
      desiredCount: 1,
      // bridge 태스크에는 태스크 ENI 가 없으므로 vpcSubnets/securityGroups 를 줄 수
      // 없다(CDK 가 합성 단계에서 거부한다). 이 태스크의 네트워크 정체성은
      // 호스트 ENI 와 `DevAppHostSg` 다.
      capacityProviderStrategies: [
        { capacityProvider: capacityProvider.capacityProviderName, weight: 1 },
      ],
      propagateTags: PropagatedTagSource.SERVICE,
      ...REPLACEMENT_DEPLOYMENT,
    });
  }

  // ============================================================
  // 태스크 ③ : ClickHouse - awsvpc
  // ============================================================
  private buildClickhouseService(
    props: DevApplicationStackProps,
    capacityProvider: AsgCapacityProvider,
  ): Ec2Service {
    const task = new Ec2TaskDefinition(this, 'DevClickhouseTask', {
      // **awsvpc 여야 한다.** Cloud Map 에 A 레코드(`clickhouse.obs.local`)를
      // 등록하려면 태스크에 전용 IP 가 있어야 한다. bridge/host 모드에서는 Cloud
      // Map 이 **SRV 레코드만** 등록하고, SRV 는 일반 HTTP 클라이언트가 해석하지
      // 못한다. 그러면 `ENRICHMENT_CH_URL` 계약이 dev 에서만 깨지고, 앱은 이름이
      // 안 풀리면 예외 없이 compose 기본값으로 조용히 폴백하므로 증상은 "컨테이너는
      // RUNNING 인데 모든 적재가 503"이다. (ADR-0005, ADR-0018, ADR-0022 4번)
      networkMode: NetworkMode.AWS_VPC,
    });
    task.addVolume({
      name: 'ch-data',
      host: { sourcePath: '/data/clickhouse' },
    });

    const container = task.addContainer('clickhouse', {
      image: ContainerImage.fromRegistry(CLICKHOUSE_IMAGE),
      // 이 env 가 없으면 이미지 entrypoint 가 default 유저를 루프백 전용으로 잠가
      // post-processor 의 모든 적재가 인증 실패로 죽는다. **값을 바꾸지 않고
      // 그대로 전개한다.** (`AGENTS.md` 3장, ADR-0019)
      environment: { ...CLICKHOUSE_CONTAINER_ENV },
      memoryReservationMiB: MEMORY_RESERVATION_MIB.clickhouse,
      portMappings: [
        { containerPort: PORTS.clickhouseHttp },
        { containerPort: PORTS.clickhouseNative },
      ],
      logging: LogDriver.awsLogs({
        streamPrefix: 'clickhouse',
        logGroup: this.makeLogGroup('DevClickhouseLog', 'clickhouse'),
      }),
    });
    container.addMountPoints({
      sourceVolume: 'ch-data',
      containerPath: '/var/lib/clickhouse',
      readOnly: false,
    });

    return new Ec2Service(this, 'DevClickhouseService', {
      cluster: this.cluster,
      taskDefinition: task,
      desiredCount: 1,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [props.clickhouseSecurityGroup],
      capacityProviderStrategies: [
        { capacityProvider: capacityProvider.capacityProviderName, weight: 1 },
      ],
      cloudMapOptions: {
        name: CLICKHOUSE_SERVICE_NAME,
        cloudMapNamespace: this.namespace,
        dnsRecordType: DnsRecordType.A,
      },
      propagateTags: PropagatedTagSource.SERVICE,
      ...REPLACEMENT_DEPLOYMENT,
    });
  }
}
