import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  BlockDeviceVolume,
  EbsDeviceVolumeType,
} from 'aws-cdk-lib/aws-autoscaling';
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  ISecurityGroup,
  IVpc,
  SubnetSelection,
} from 'aws-cdk-lib/aws-ec2';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import {
  AmiHardwareType,
  AsgCapacityProvider,
  Cluster,
  ContainerImage,
  CpuArchitecture,
  Ec2Service,
  Ec2TaskDefinition,
  EcsOptimizedImage,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  NetworkMode,
  OperatingSystemFamily,
  PropagatedTagSource,
  RuntimePlatform,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { DnsRecordType, PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
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
  PRIMARY_AZ_INDEX,
  SUBNET_GROUP,
} from './config';

/**
 * Fargate 태스크는 ARM64(Graviton)로 통일한다. ClickHouse EC2(t4g)와 아키텍처를
 * 맞추고 x86 대비 약 20% 저렴하다. 앱 레포는 반드시 `linux/arm64` 이미지를
 * push해야 한다. amd64 이미지를 올리면 합성과 테스트는 통과하지만 런타임에
 * 이미지 pull이 실패한다. (ADR-0015)
 */
const FARGATE_RUNTIME_PLATFORM: RuntimePlatform = {
  cpuArchitecture: CpuArchitecture.ARM64,
  operatingSystemFamily: OperatingSystemFamily.LINUX,
};

/**
 * Collector config 파일 경로. 소비처가 이 파일 하나뿐이라 `config.ts` 가 아니라
 * 여기 둔다. (ADR-0015 의 `FARGATE_RUNTIME_PLATFORM` 과 같은 판단)
 */
const COLLECTOR_CONFIG_PATH = join(
  __dirname,
  '..',
  'config',
  'otel-collector.yaml',
);

/**
 * Collector 가 config 를 읽어갈 환경변수 이름. `--config=env:<이름>` 과 짝이다.
 */
const COLLECTOR_CONFIG_ENV = 'OTEL_CONFIG';

export interface ApplicationStackProps extends StackProps {
  readonly vpc: IVpc;
  /** api-server 의 DB_CREDS 용 Aurora 마스터 시크릿. */
  readonly dbSecret: ISecret;
  /** post-processor 의 ENRICHMENT_PG_DSN 용 파생 시크릿. (ADR-0018) */
  readonly postProcessorPgDsnSecret: ISecret;
  readonly rawSignalBucket: IBucket;
  readonly collectorSecurityGroup: ISecurityGroup;
  readonly dashboardSecurityGroup: ISecurityGroup;
  readonly clickhouseSecurityGroup: ISecurityGroup;
}

/**
 * ApplicationStack: ECS Cluster(단일), Cloud Map, Fargate 서비스 2개,
 * ClickHouse EC2(ASG + Capacity Provider + Ec2Service).
 */
export class ApplicationStack extends Stack {
  public readonly collectorService: FargateService;
  public readonly dashboardService: FargateService;

  private readonly cluster: Cluster;
  private readonly namespace: PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
    });

    this.namespace = new PrivateDnsNamespace(this, 'Namespace', {
      name: CLOUD_MAP_NAMESPACE,
      vpc: props.vpc,
    });

    this.collectorService = this.buildCollectorService(props);
    this.dashboardService = this.buildDashboardService(props);
    this.buildClickhouse(props);
  }

  private makeLogGroup(id: string, name: string): LogGroup {
    return new LogGroup(this, id, {
      logGroupName: name,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  private primaryAppSubnetSelection(vpc: IVpc): SubnetSelection {
    return {
      subnetGroupName: SUBNET_GROUP.app,
      availabilityZones: [vpc.availabilityZones[PRIMARY_AZ_INDEX]],
    };
  }

  // ============================================================
  // Fargate ① : Collector & Post Processor
  // ============================================================
  private buildCollectorService(
    props: ApplicationStackProps,
  ): FargateService {
    const task = new FargateTaskDefinition(this, 'CollectorTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: FARGATE_RUNTIME_PLATFORM,
    });

    // 애플리케이션 런타임에 필요한 S3 권한만 task role에 부여한다.
    props.rawSignalBucket.grantReadWrite(task.taskRole);

    task.addContainer('otel-collector', {
      image: ContainerImage.fromRegistry(
        'otel/opentelemetry-collector-contrib',
      ),
      // 이 이미지는 User=10001:10001 로 도는데, config 의 file exporter 가
      // /data 를 만들려면 루트 파일시스템에 써야 한다. 이미지에 UID 10001 이
      // 쓸 수 있는 디렉터리가 하나도 없어서(scratch 기반이라 /tmp 도 없다)
      // root 로 실행한다. 이걸 빼면 `mkdir /data: permission denied` 로
      // 기동 직후 exit 1 이다. config 에서 file exporter 를 없애면 이 줄도
      // 함께 없앤다 — 둘은 한 몸이다. (ADR-0017)
      user: '0',
      // 이미지의 ENTRYPOINT(/otelcol-contrib)는 유지되고 CMD 만 대체된다.
      // 즉 최종 실행은 `/otelcol-contrib --config=env:OTEL_CONFIG`. (ADR-0017)
      command: [`--config=env:${COLLECTOR_CONFIG_ENV}`],
      environment: {
        // config 본문 전체를 환경변수로 넘긴다. 이 값은 CloudFormation 템플릿과
        // ECS 콘솔에 평문으로 남으므로 config 에 시크릿을 넣으면 안 된다.
        [COLLECTOR_CONFIG_ENV]: readFileSync(COLLECTOR_CONFIG_PATH, 'utf8'),
      },
      portMappings: [{ containerPort: PORTS.otlp }],
      logging: LogDriver.awsLogs({
        streamPrefix: 'otel-collector',
        logGroup: this.makeLogGroup('CollectorLog', '/ecs/collector'),
      }),
    });

    task.addContainer('post-processor', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'PostProcessorRepo',
          ECR_REPOS.postProcessor,
        ),
      ),
      // 이 이름들은 앱 소스(ai-telemetry-pipeline)가 권위다. 앱이 os.environ 으로
      // 읽는 이름과 한 글자라도 다르면 조용히 compose 전용 기본값으로 폴백하고,
      // ECS 에서는 DNS 가 안 풀려 모든 insert 가 503 이 된다. (ADR-0018)
      environment: {
        [ENRICHMENT_ENV.clickhouseUrl]: CLICKHOUSE_HTTP_URL,
        [ENRICHMENT_ENV.clickhouseDb]: CLICKHOUSE_DEFAULT_DB,
        // 앱은 아직 이 값을 읽지 않는다. ADR-0017 이 예고한 collector 의 awss3
        // exporter 전환에 대비해 위 grantReadWrite 와 함께 의도적으로 남겨둔다.
        // 지금 지우면 전환 시점에 둘 다 되살려야 한다.
        RAW_BUCKET: props.rawSignalBucket.bucketName,
      },
      // DSN 에는 DB 비밀번호가 통째로 들어 있으므로 environment 가 아니라 secrets 로
      // 넣는다. 그래야 `aws ecs describe-task-definition` 과 ECS 콘솔에 valueFrom(ARN)
      // 만 보이고 평문이 남지 않는다. addContainer 가 execution role 에 grantRead 를
      // 자동으로 붙여준다. (ADR-0018)
      secrets: {
        [ENRICHMENT_ENV.pgDsn]: EcsSecret.fromSecretsManager(
          props.postProcessorPgDsnSecret,
        ),
      },
      // awsvpc 에서 기능상 필수는 아니지만, collector 가 localhost 의 이 포트로
      // OTLP 를 밀어넣는다는 계약을 태스크 정의에 남긴다. (ADR-0017)
      portMappings: [{ containerPort: PORTS.postProcessor }],
      logging: LogDriver.awsLogs({
        streamPrefix: 'post-processor',
        logGroup: this.makeLogGroup('PostProcessorLog', '/ecs/post-processor'),
      }),
    });

    return new FargateService(this, 'CollectorService', {
      cluster: this.cluster,
      taskDefinition: task,
      desiredCount: 1,
      vpcSubnets: this.primaryAppSubnetSelection(props.vpc),
      securityGroups: [props.collectorSecurityGroup],
      assignPublicIp: false,
      // ECS Exec. CDK 가 task role 에 ssmmessages 4개 액션을 자동으로 붙인다.
      // 컨테이너 이미지에 셸이 있어야 실제로 접속된다. (ADR-0016)
      enableExecuteCommand: true,
      // 서비스 태그(= App 스코프 공통 태그)를 실행 중인 태스크까지 내린다.
      propagateTags: PropagatedTagSource.SERVICE,
    });
  }

  // ============================================================
  // Fargate ② : Dashboard Backend
  // ============================================================
  private buildDashboardService(
    props: ApplicationStackProps,
  ): FargateService {
    const task = new FargateTaskDefinition(this, 'DashboardTask', {
      cpu: 512,
      // Fargate 는 CPU/메모리 조합이 고정이다. 512 CPU 에 허용되는 메모리는
      // 1024 / 2048 / 3072 / 4096 뿐이라 1536 은 태스크 정의 생성 자체가 실패한다.
      // Spring Boot 를 고려해 1024 대신 2048 을 쓴다.
      memoryLimitMiB: 2048,
      runtimePlatform: FARGATE_RUNTIME_PLATFORM,
    });

    task.addContainer('api-server', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'ApiServerRepo',
          ECR_REPOS.apiServer,
        ),
      ),
      portMappings: [{ containerPort: PORTS.apiServer }],
      environment: {
        // DB_CREDS 시크릿에는 dbname 이 없다. DB 이름은 여기서만 전달한다.
        DB_NAME: CONTROL_DB_NAME,
      },
      secrets: {
        DB_CREDS: EcsSecret.fromSecretsManager(props.dbSecret),
      },
      logging: LogDriver.awsLogs({
        streamPrefix: 'api-server',
        logGroup: this.makeLogGroup('ApiServerLog', '/ecs/api-server'),
      }),
    });

    task.addContainer('batch-processor', {
      image: ContainerImage.fromEcrRepository(
        Repository.fromRepositoryName(
          this,
          'BatchRepo',
          ECR_REPOS.batchProcessor,
        ),
      ),
      essential: false, // 배치 실패가 api-server 태스크를 내리지 않게 함 (ADR-0004)
      environment: {
        CLICKHOUSE_HOST: CLICKHOUSE_HOST,
      },
      logging: LogDriver.awsLogs({
        streamPrefix: 'batch-processor',
        logGroup: this.makeLogGroup('BatchLog', '/ecs/batch'),
      }),
    });

    return new FargateService(this, 'DashboardService', {
      cluster: this.cluster,
      taskDefinition: task,
      desiredCount: 1,
      vpcSubnets: this.primaryAppSubnetSelection(props.vpc),
      securityGroups: [props.dashboardSecurityGroup],
      assignPublicIp: false,
      // ECS Exec. CDK 가 task role 에 ssmmessages 4개 액션을 자동으로 붙인다.
      // 컨테이너 이미지에 셸이 있어야 실제로 접속된다. (ADR-0016)
      enableExecuteCommand: true,
      propagateTags: PropagatedTagSource.SERVICE,
    });
  }

  // ============================================================
  // ClickHouse : EC2 launch type
  // ============================================================
  private buildClickhouse(props: ApplicationStackProps): void {
    const asg = new AutoScalingGroup(this, 'ClickhouseAsg', {
      vpc: props.vpc,
      vpcSubnets: this.primaryAppSubnetSelection(props.vpc),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
      machineImage: EcsOptimizedImage.amazonLinux2023(AmiHardwareType.ARM),
      minCapacity: 1,
      maxCapacity: 1,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda', // 루트
          volume: BlockDeviceVolume.ebs(30, {
            volumeType: EbsDeviceVolumeType.GP3,
          }),
        },
        {
          deviceName: '/dev/xvdb', // ClickHouse 데이터
          volume: BlockDeviceVolume.ebs(50, {
            volumeType: EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    asg.addUserData(...clickhouseUserData());

    // Session Manager 로 인스턴스에 접속하기 위한 최소 권한. 인바운드 포트나
    // 키페어 없이 접속하므로 SSH 를 열지 않아도 된다. 접근 통제의 실체는
    // 운영자 IAM 쪽 ssm:StartSession 권한이며 이 레포 범위 밖이다. (ADR-0016)
    asg.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    const capacityProvider = new AsgCapacityProvider(
      this,
      'ClickhouseCapacityProvider',
      {
        autoScalingGroup: asg,
        // 단일 인스턴스 교체 배포를 허용하기 위해 관리형 종료 보호 비활성.
        enableManagedTerminationProtection: false,
      },
    );
    this.cluster.addAsgCapacityProvider(capacityProvider);

    const task = new Ec2TaskDefinition(this, 'ClickhouseTask', {
      networkMode: NetworkMode.AWS_VPC, // Cloud Map A레코드 등록을 위해 awsvpc
    });
    task.addVolume({
      name: 'ch-data',
      host: { sourcePath: '/data/clickhouse' },
    });

    const container = task.addContainer('clickhouse', {
      image: ContainerImage.fromRegistry(CLICKHOUSE_IMAGE),
      // 이 env 가 없으면 이미지 entrypoint 가 default 유저를 루프백 전용으로 잠가
      // post-processor 의 모든 적재가 인증 실패로 죽는다. 지우지 않는다. (ADR-0019)
      environment: { ...CLICKHOUSE_CONTAINER_ENV },
      memoryReservationMiB: 1024,
      portMappings: [
        { containerPort: PORTS.clickhouseHttp },
        { containerPort: PORTS.clickhouseNative },
      ],
      logging: LogDriver.awsLogs({
        streamPrefix: 'clickhouse',
        logGroup: this.makeLogGroup('ClickhouseLog', '/ecs/clickhouse'),
      }),
    });
    container.addMountPoints({
      sourceVolume: 'ch-data',
      containerPath: '/var/lib/clickhouse',
      readOnly: false,
    });

    new Ec2Service(this, 'ClickhouseService', {
      cluster: this.cluster,
      taskDefinition: task,
      desiredCount: 1,
      vpcSubnets: this.primaryAppSubnetSelection(props.vpc),
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
      // 단일 인스턴스 + awsvpc(ENI 1개/태스크, t4g.small ENI 한도 3)이므로
      // 롤링 배포가 불가능. 교체 배포(먼저 내리고 새로 띄움)를 강제한다.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
  }
}

/**
 * ClickHouse 데이터 볼륨(xvdb) 포맷 + /data/clickhouse 마운트 userData.
 *
 * Nitro 인스턴스에서는 /dev/xvdb symlink 가 없을 수 있어 lsblk 로 미마운트
 * 데이터 디바이스를 탐색하는 폴백을 둔다. blkid 가드로 idempotent 하게 만들고
 * /etc/fstab 에 등록해 재부팅 후에도 유지되게 한다.
 */
function clickhouseUserData(): string[] {
  return [
    'set -euxo pipefail',
    'MOUNT=/data/clickhouse',
    'mkdir -p "$MOUNT"',
    // 우선 /dev/xvdb, 없으면 lsblk 로 마운트되지 않은 빈 디스크를 찾는다.
    'DEV=/dev/xvdb',
    'if [ ! -b "$DEV" ]; then',
    "  DEV=$(lsblk -rpno NAME,TYPE,MOUNTPOINT | awk '$2==\"disk\" && $3==\"\" {print $1}' | grep -v -E 'nvme0n1$|xvda$' | head -n1)",
    'fi',
    'if [ -z "$DEV" ]; then echo "no data device found" >&2; exit 1; fi',
    // 파일시스템이 없을 때만 포맷 (idempotent).
    'if ! blkid "$DEV"; then mkfs -t xfs "$DEV"; fi',
    'UUID=$(blkid -s UUID -o value "$DEV")',
    'grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $MOUNT xfs defaults,nofail 0 2" >> /etc/fstab',
    'mountpoint -q "$MOUNT" || mount "$MOUNT"',
  ];
}
