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
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { DnsRecordType, PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  CLICKHOUSE_HOST,
  CLICKHOUSE_SERVICE_NAME,
  CLOUD_MAP_NAMESPACE,
  CONTROL_DB_NAME,
  ECR_REPOS,
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

export interface ApplicationStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly dbSecret: ISecret;
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
      environment: {
        CLICKHOUSE_HOST: CLICKHOUSE_HOST,
        RAW_BUCKET: props.rawSignalBucket.bucketName,
        // DB_CREDS 시크릿에는 dbname 이 없다. DB 이름은 여기서만 전달한다.
        DB_NAME: CONTROL_DB_NAME,
      },
      secrets: {
        DB_CREDS: EcsSecret.fromSecretsManager(props.dbSecret),
      },
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
      image: ContainerImage.fromRegistry('clickhouse/clickhouse-server'),
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
