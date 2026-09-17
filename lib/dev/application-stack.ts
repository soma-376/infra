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
  ContainerDefinition,
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
  CLICKHOUSE_HTTP_URL,
  CLICKHOUSE_IMAGE,
  CLICKHOUSE_SERVICE_NAME,
  CLOUD_MAP_NAMESPACE,
  CONTROL_DB_NAME,
  CONTROL_DB_SSLMODE,
  ECR_REPOS,
  ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY,
  ENROLLMENT_ENV,
  INGEST_ENV,
  PORTS,
  buildJdbcUrl,
} from '../common/config';
import {
  ECS_CLUSTER_NAMES,
  ECS_SERVICE_NAMES,
} from '../common/deploy-targets';
import { clickhouseUserData } from '../common/clickhouse-user-data';
import {
  DevConfig,
  DEV_APP_INSTANCE_TYPE,
  DEV_CLICKHOUSE_DATA_VOLUME_GIB,
  DEV_CLICKHOUSE_INSTANCE_TYPE,
  DEV_ENROLLMENT_BINARIES_DIR,
  DEV_LOG_GROUP_PREFIX,
  DEV_TELEMETRY_ARCHIVE_PREFIX,
  DEV_TELEMETRY_INGEST_HEALTH_CHECK_GRACE,
} from './config';

/** 컨테이너 소프트 메모리 예약(MiB). EC2 launch type 이므로 하드 리밋은 두지 않는다. */
const MEMORY_RESERVATION_MIB = {
  clickhouse: 1024,
  // Spring heap·off-heap을 합친 실사용 충분성은 배포 뒤 별도로 관측한다. (ADR-0026)
  telemetryIngest: 1024,
  enrollmentApi: 1024,
} as const;

/**
 * dev 서비스 공통 배포 전략: 먼저 내리고 새로 띄우는 **교체 배포**.
 *
 * t4g 계열의 인스턴스당 ENI 한도는 프라이머리 포함 3 이고 awsvpc 태스크는 태스크당
 * ENI 를 하나 잡는다. 최종 앱 ASG는 한 대이므로 롤링 배포에 필요한 새 태스크 자리를
 * 전제로 하지 않는다.
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
  /** 신규 두 Spring 앱 JDBC URL의 RDS 엔드포인트 호스트명. */
  readonly dbEndpoint: string;
  /** 신규 두 Spring 앱 username/password용 RDS 마스터 시크릿. */
  readonly dbSecret: ISecret;
  /** enrollment-api 의 PULSEMETRY_ADMIN_API_TOKEN 용 Secret. */
  readonly adminApiTokenSecret: ISecret;
  /** 신규 두 Spring 앱이 공유하는 토큰 해시 Secret. (ADR-0026) */
  readonly tokenHashSecret: ISecret;
  readonly rawSignalBucket: IBucket;
  /** EC2 호스트 2대 공용 SG. ASG 에 붙는다. */
  readonly appHostSecurityGroup: ISecurityGroup;
  /** ClickHouse 태스크 ENI(awsvpc)용 SG. */
  readonly clickhouseSecurityGroup: ISecurityGroup;
}

interface EnrollmentApiResources {
  readonly task: Ec2TaskDefinition;
  readonly container: ContainerDefinition;
  readonly service: Ec2Service;
}

/**
 * DevApplicationStack: ECS 클러스터(단일), Cloud Map `obs.local`,
 * ASG 2개 + 캐패시티 프로바이더 2개, 최종 Ec2Service 3개.
 *
 * 운영과의 기본 차이는 **launch type 과 네트워크 모드**다. dev는 backend의
 * telemetry-ingest와 enrollment-api를 독립 bridge 서비스로 실행하며, ClickHouse만
 * Cloud Map A 레코드를 위해 awsvpc를 쓴다. prod 전환은 별도 작업이다. (ADR-0026)
 *
 * 태스크마다 네트워크 모드가 다르다. ADR-0022 4번이 awsvpc 를 **강제하는 조건**을
 * 둘만 인정하고(태스크 내 localhost 의존 / Cloud Map A 레코드 등록 대상), 나머지는
 * bridge 로 두어 인터넷 egress 와 ENI 여유를 얻는다는 규칙이다. 각 태스크 빌더의
 * 주석에 그 판정이 있다. (ADR-0022 4번, ADR-0023 2번)
 */
export class DevApplicationStack extends Stack {
  public readonly cluster: Cluster;
  public readonly clickhouseService: Ec2Service;
  /** Spring 수집 서비스. ALB의 정확한 OTLP 세 경로를 받는다. (ADR-0026) */
  public readonly telemetryIngestService: Ec2Service;
  /** enrollment-api 태스크와 서비스. enrollment·bootstrap 경로를 받는다. */
  public readonly enrollmentApiTask: Ec2TaskDefinition;
  public readonly enrollmentApiService: Ec2Service;

  private readonly enrollmentApiContainer: ContainerDefinition;

  private readonly namespace: PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: DevApplicationStackProps) {
    super(scope, id, props);

    this.cluster = new Cluster(this, 'DevCluster', {
      vpc: props.vpc,
      // 물리 이름을 명시한다. 앱 레포 워크플로우의 `--cluster` 인자이자 `DeployStack` 이
      // IAM 서비스 ARN 을 조립하는 조각이다. **클러스터 이름은 계정 + 리전에서 유일해야
      // 하므로 이 값이 운영과 달라야 한다** - 로그 그룹의 `/ecs/dev/` 접두와 같은 사정이다.
      // 교체 유발 속성이라 이미 배포된 스택에 추가하면 재생성된다 (AGENTS.md 6장 런북).
      // (ADR-0021 Constraints, ADR-0024 6번)
      clusterName: ECS_CLUSTER_NAMES.dev,
    });

    // 네임스페이스 이름은 운영과 **같은 `obs.local`** 이다. private DNS
    // 네임스페이스는 VPC 스코프라 같은 계정에 동명이 둘 있어도 충돌하지 않고,
    // 각각 자신이 연결된 VPC 안에서만 해석된다.
    //
    // 이름을 맞추는 것은 우연한 편의가 아니라 의도한 결과다 -
    // `CLICKHOUSE_HTTP_URL = http://clickhouse.obs.local:8123` 이 dev 와 prod 에서
    // 한 값으로 유지되어야 telemetry-ingest의 ClickHouse URL 계약이 갈라지지 않는다.
    // (ADR-0005, ADR-0021 5번)
    this.namespace = new PrivateDnsNamespace(this, 'DevNamespace', {
      name: CLOUD_MAP_NAMESPACE,
      vpc: props.vpc,
    });

    const appCapacityProvider = this.buildAppAsg(props);
    const clickhouseCapacityProvider = this.buildClickhouseAsg(props);

    this.telemetryIngestService = this.buildTelemetryIngestService(
      props,
      appCapacityProvider,
    );
    const enrollmentApi = this.buildEnrollmentApiService(
      props,
      appCapacityProvider,
    );
    this.enrollmentApiTask = enrollmentApi.task;
    this.enrollmentApiContainer = enrollmentApi.container;
    this.enrollmentApiService = enrollmentApi.service;
    this.clickhouseService = this.buildClickhouseService(
      props,
      clickhouseCapacityProvider,
    );
  }

  /**
   * EdgeStack이 만든 실제 ALB DNS를 enrollment-api 환경변수에 뒤늦게 연결한다.
   * `synthDev()`가 EdgeStack 생성 직후 반드시 호출하며, weak cross-stack reference를
   * 그대로 사용한다. context나 localhost 기본값으로 우회하지 않는다. (ADR-0026)
   */
  public bindEnrollmentPublicBaseUrl(publicBaseUrl: string): void {
    this.enrollmentApiContainer.addEnvironment(
      ENROLLMENT_ENV.publicBaseUrl,
      publicBaseUrl,
    );
  }

  /**
   * 로그 그룹 이름에 `/ecs/dev/` 접두를 붙이고, 보존 기간과 삭제 정책은
   * 기존 dev 기준을 유지한다. 접두사를 빼면 운영의 동명 로그 그룹과 충돌한다.
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
  // ASG ① : 앱 호스트 (ClickHouse 외 모든 dev 앱 태스크)
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
  // 태스크 ① : Telemetry Ingest - bridge
  // ============================================================
  private buildTelemetryIngestService(
    props: DevApplicationStackProps,
    capacityProvider: AsgCapacityProvider,
  ): Ec2Service {
    const task = new Ec2TaskDefinition(this, 'DevTelemetryIngestTask', {
      // 단일 컨테이너이고 Cloud Map 등록 대상이 아니므로 awsvpc 강제 조건이 없다.
      // bridge 를 써서 기존 앱 호스트의 인터넷 egress와 ENI 여유를 그대로 사용한다.
      // 인바운드는 PROJ-143에서 기존 ALB -> 앱 호스트 동적 포트 SG 룰을 재사용한다.
      // (ADR-0022 4번, ADR-0026)
      networkMode: NetworkMode.BRIDGE,
    });

    // archive type이 s3이므로 애플리케이션 task role에 같은 Raw Signal 버킷의
    // read/write만 부여한다. execution role의 이미지·로그·Secret 권한과 분리한다.
    props.rawSignalBucket.grantReadWrite(task.taskRole);

    task.addContainer('telemetry-ingest', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'DevTelemetryIngestRepo',
          ECR_REPOS.telemetryIngest,
        ),
        props.devConfig.imageTag,
      ),
      // hostPort 를 생략해 bridge 동적 포트를 쓴다.
      portMappings: [{ containerPort: PORTS.telemetryIngest }],
      // 이름의 권위는 backend telemetry-ingest application.yaml이다. 비밀이 아닌
      // endpoint·bucket 설정만 environment에 두고, 자격증명과 token hash는 아래
      // ECS secrets로 주입한다. (ADR-0026)
      environment: {
        [INGEST_ENV.port]: String(PORTS.telemetryIngest),
        [INGEST_ENV.dbUrl]: buildJdbcUrl({
          host: props.dbEndpoint,
          port: PORTS.aurora,
          dbname: CONTROL_DB_NAME,
          sslmode: CONTROL_DB_SSLMODE,
        }),
        [INGEST_ENV.clickhouseUrl]: CLICKHOUSE_HTTP_URL,
        [INGEST_ENV.clickhouseDatabase]: CLICKHOUSE_DEFAULT_DB,
        [INGEST_ENV.archiveType]: 's3',
        [INGEST_ENV.archiveBucket]: props.rawSignalBucket.bucketName,
        [INGEST_ENV.archivePrefix]: DEV_TELEMETRY_ARCHIVE_PREFIX,
      },
      secrets: {
        [INGEST_ENV.dbUsername]: EcsSecret.fromSecretsManager(
          props.dbSecret,
          'username',
        ),
        [INGEST_ENV.dbPassword]: EcsSecret.fromSecretsManager(
          props.dbSecret,
          'password',
        ),
        [INGEST_ENV.tokenHashSecret]: EcsSecret.fromSecretsManager(
          props.tokenHashSecret,
        ),
      },
      memoryReservationMiB: MEMORY_RESERVATION_MIB.telemetryIngest,
      logging: LogDriver.awsLogs({
        streamPrefix: 'telemetry-ingest',
        logGroup: this.makeLogGroup(
          'DevTelemetryIngestLog',
          'telemetry-ingest',
        ),
      }),
    });

    return new Ec2Service(this, 'DevTelemetryIngestService', {
      cluster: this.cluster,
      taskDefinition: task,
      serviceName: ECS_SERVICE_NAMES.telemetryIngest,
      desiredCount: 1,
      // bridge 태스크라 태스크 전용 subnet/SG를 주지 않는다. 기존 DevAppAsg와
      // DevAppHostSg의 네트워크 정체성을 사용한다.
      capacityProviderStrategies: [
        { capacityProvider: capacityProvider.capacityProviderName, weight: 1 },
      ],
      // ClickHouse 스키마 준비의 최장 재시도 경로가 CDK 기본 60초를
      // 넘을 수 있어 ingest에만 명시적으로 기동 유예를 둔다. (ADR-0026)
      healthCheckGracePeriod: DEV_TELEMETRY_INGEST_HEALTH_CHECK_GRACE,
      propagateTags: PropagatedTagSource.SERVICE,
      ...REPLACEMENT_DEPLOYMENT,
    });
  }

  // ============================================================
  // 태스크 ② : Enrollment API - bridge
  // ============================================================
  private buildEnrollmentApiService(
    props: DevApplicationStackProps,
    capacityProvider: AsgCapacityProvider,
  ): EnrollmentApiResources {
    const task = new Ec2TaskDefinition(this, 'DevEnrollmentApiTask', {
      // 단일 Spring 컨테이너이고 Cloud Map 등록 대상이 아니므로 bridge를 쓴다.
      // 기존 앱 호스트의 egress와 ENI를 재사용하고 host port는 동적으로 받는다.
      // (ADR-0022 4번, ADR-0026)
      networkMode: NetworkMode.BRIDGE,
    });

    const container = task.addContainer('enrollment-api', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'DevEnrollmentApiRepo',
          ECR_REPOS.enrollmentApi,
        ),
        props.devConfig.imageTag,
      ),
      portMappings: [{ containerPort: PORTS.enrollmentApi }],
      environment: {
        [ENROLLMENT_ENV.dbUrl]: buildJdbcUrl({
          host: props.dbEndpoint,
          port: PORTS.aurora,
          dbname: CONTROL_DB_NAME,
          sslmode: CONTROL_DB_SSLMODE,
        }),
        [ENROLLMENT_ENV.binariesDir]: DEV_ENROLLMENT_BINARIES_DIR,
        // PULSEMETRY_PUBLIC_BASE_URL은 EdgeStack 생성 뒤 bind 메서드가 실제 ALB DNS로
        // 추가한다. 여기서 localhost나 별도 context 기본값을 두지 않는다.
      },
      secrets: {
        [ENROLLMENT_ENV.dbUsername]: EcsSecret.fromSecretsManager(
          props.dbSecret,
          'username',
        ),
        [ENROLLMENT_ENV.dbPassword]: EcsSecret.fromSecretsManager(
          props.dbSecret,
          'password',
        ),
        [ENROLLMENT_ENV.adminApiToken]: EcsSecret.fromSecretsManager(
          props.adminApiTokenSecret,
          ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY,
        ),
        [ENROLLMENT_ENV.tokenHashSecret]: EcsSecret.fromSecretsManager(
          props.tokenHashSecret,
        ),
      },
      memoryReservationMiB: MEMORY_RESERVATION_MIB.enrollmentApi,
      logging: LogDriver.awsLogs({
        streamPrefix: 'enrollment-api',
        logGroup: this.makeLogGroup(
          'DevEnrollmentApiLog',
          'enrollment-api',
        ),
      }),
    });

    const service = new Ec2Service(this, 'DevEnrollmentApiService', {
      cluster: this.cluster,
      taskDefinition: task,
      serviceName: ECS_SERVICE_NAMES.enrollmentApi,
      desiredCount: 1,
      capacityProviderStrategies: [
        { capacityProvider: capacityProvider.capacityProviderName, weight: 1 },
      ],
      // ALB target이 붙으면 CDK 기본 60초 health check 기동 유예를 쓴다.
      propagateTags: PropagatedTagSource.SERVICE,
      ...REPLACEMENT_DEPLOYMENT,
    });

    return { task, container, service };
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
      // 못한다. 그러면 telemetry-ingest의 `PULSEMETRY_CLICKHOUSE_URL`이 가리키는
      // 호스트를 찾지 못해 적재가 실패한다. (ADR-0005, ADR-0022 4번, ADR-0026)
      networkMode: NetworkMode.AWS_VPC,
    });
    task.addVolume({
      name: 'ch-data',
      host: { sourcePath: '/data/clickhouse' },
    });

    const container = task.addContainer('clickhouse', {
      image: ContainerImage.fromRegistry(CLICKHOUSE_IMAGE),
      // 이 env 가 없으면 이미지 entrypoint 가 default 유저를 루프백 전용으로 잠가
      // telemetry-ingest의 모든 적재가 인증 실패로 죽는다. **값을 바꾸지 않고
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
      // 이름만 고정한다. 공개 이미지 고정 태그라(ADR-0019) 앱 레포가 재배포할 대상이
      // 아니고, 어느 배포 역할에도 이 ARN 이 없다.
      serviceName: ECS_SERVICE_NAMES.clickhouse,
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
