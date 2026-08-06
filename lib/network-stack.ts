import { Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  GatewayVpcEndpointAwsService,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { PORTS, SUBNET_GROUP } from './config';

/**
 * NetworkStack: VPC(단일 AZ, 3계층) + S3 게이트웨이 엔드포인트 + SG 5개 전부.
 *
 * SG 5개와 상호 규칙을 모두 최상류 이 스택에 배치한다. SG 간 참조가 스택 내부
 * 참조가 되어 스택 간 순환 의존을 원천 차단하고, 하류 스택은 props 로 주입만 받는다.
 */
export class NetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly albSecurityGroup: SecurityGroup;
  public readonly collectorSecurityGroup: SecurityGroup;
  public readonly dashboardSecurityGroup: SecurityGroup;
  public readonly clickhouseSecurityGroup: SecurityGroup;
  public readonly auroraSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'Vpc', {
      // Aurora DatabaseCluster 와 internet-facing ALB 는 최소 2개 AZ 의 서브넷을
      // 요구한다(ADR-0011 이 예고한 제약). 순수 단일 AZ 로는 synth 자체가 실패하므로
      // AZ 는 2개로 두되, NAT GW 는 1대만 두어 비용 최소화 의도는 유지한다.
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: SUBNET_GROUP.public, subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: SUBNET_GROUP.app,
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: SUBNET_GROUP.db,
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // S3 게이트웨이 엔드포인트: Raw Signal S3 접근 + ECR 레이어 다운로드가 NAT 를 우회.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });

    this.albSecurityGroup = new SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB - inbound 80/443 from anywhere',
      allowAllOutbound: true,
    });
    this.collectorSecurityGroup = new SecurityGroup(this, 'CollectorSg', {
      vpc: this.vpc,
      description: 'Collector Fargate service',
      allowAllOutbound: true,
    });
    this.dashboardSecurityGroup = new SecurityGroup(this, 'DashboardSg', {
      vpc: this.vpc,
      description: 'Dashboard Fargate service',
      allowAllOutbound: true,
    });
    this.clickhouseSecurityGroup = new SecurityGroup(this, 'ClickhouseSg', {
      vpc: this.vpc,
      description: 'ClickHouse EC2 task',
      allowAllOutbound: true,
    });
    this.auroraSecurityGroup = new SecurityGroup(this, 'AuroraSg', {
      vpc: this.vpc,
      description: 'Aurora control plane',
      allowAllOutbound: true,
    });

    this.wireSecurityGroupRules();
  }

  private wireSecurityGroupRules(): void {
    // ALB: 인터넷에서 80/443 수신.
    this.albSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(PORTS.https),
      'HTTPS from anywhere',
    );
    this.albSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(PORTS.http),
      'HTTP from anywhere (redirect / fallback)',
    );

    // Collector ← ALB:4318 (OTLP).
    this.collectorSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      Port.tcp(PORTS.otlp),
      'OTLP from ALB',
    );

    // Dashboard ← ALB:8080.
    this.dashboardSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      Port.tcp(PORTS.apiServer),
      'API from ALB',
    );

    // ClickHouse ← {collector, dashboard}:8123/9000.
    for (const peer of [
      this.collectorSecurityGroup,
      this.dashboardSecurityGroup,
    ]) {
      this.clickhouseSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.clickhouseHttp),
        'ClickHouse HTTP',
      );
      this.clickhouseSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.clickhouseNative),
        'ClickHouse native',
      );
    }

    // Aurora ← {collector, dashboard}:5432.
    for (const peer of [
      this.collectorSecurityGroup,
      this.dashboardSecurityGroup,
    ]) {
      this.auroraSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.aurora),
        'Postgres from app tier',
      );
    }
  }
}
