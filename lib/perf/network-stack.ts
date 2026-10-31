import { Stack, StackProps } from 'aws-cdk-lib/core';
import {
  CfnEIP, GatewayVpcEndpointAwsService, IpAddresses, ISubnet, Peer, Port, SecurityGroup, SubnetType, Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PERF_GATEWAY_NODE_PORT } from './edge-config';
import { PERF_MSK_IAM_PORT, PERF_PORTS } from './config';
import { PERF_POOL_IDS, PerfPoolId } from './profile';

export interface PerfNetworkStackProps extends StackProps {
  readonly vpcCidr: string;
  /** 노드를 두는 단일 AZ. EKS control plane·RDS·MSK subnet은 3 AZ 모두에 있다. */
  readonly nodeAvailabilityZone: string;
  readonly natGateways: number;
  readonly kafkaProvider?: 'strimzi';
  readonly httpsGateway?: boolean;
}

/** subnet 그룹 이름. CloudFormation logical ID와 subnet 선택이 이 이름을 쓴다. */
export const PERF_SUBNET_GROUPS = { public: 'perf-public', private: 'perf-private', msk: 'perf-msk' } as const;
export const PERF_AVAILABILITY_ZONES = ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c'] as const;

/**
 * PerfNetworkStack: perf 전용 VPC와 모든 SG·cross-SG 규칙.
 *
 * **SG와 cross-SG 규칙은 이 스택에만 둔다.** prod·dev NetworkStack과 같은 불변 규칙이다(AGENTS.md 3장, ADR-0022 2번).
 * 노드·도구는 private subnet에 두고 NAT와 S3 gateway endpoint로 나간다. 노드는 public IP가 없고 선택적 공개 listener는 Edge가 소유한다.
 *
 * 노드 SG는 공통 SG 하나와 pool별 SG 하나를 함께 붙인다. 공통 SG는 control plane·DNS·노드 수준 scrape만 받고,
 * 업무 포트는 pool SG가 출발 pool을 지정해 받는다. Pod는 노드 SG를 쓰므로 이 규칙이 Pod 사이 경계다.
 */
export class PerfNetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly nodeSubnets: readonly ISubnet[];
  public readonly controlPlaneSubnets: readonly ISubnet[];
  public readonly mskSubnets: readonly ISubnet[];
  public readonly dataSubnets: readonly ISubnet[];
  public readonly controlPlaneSecurityGroup: SecurityGroup;
  public readonly relaySecurityGroup: SecurityGroup;
  public readonly nodeSecurityGroup: SecurityGroup;
  public readonly poolSecurityGroups: Readonly<Record<PerfPoolId, SecurityGroup>>;
  public readonly rdsSecurityGroup: SecurityGroup;
  public readonly albSecurityGroup?: SecurityGroup;
  public readonly natPublicIps: readonly string[];
  public readonly mskSecurityGroup?: SecurityGroup;
  private readonly poolIds: readonly PerfPoolId[];

  constructor(scope: Construct, id: string, props: PerfNetworkStackProps) {
    super(scope, id, props);
    this.poolIds = props.kafkaProvider === 'strimzi' ? [...PERF_POOL_IDS, 'kafka'] : PERF_POOL_IDS;
    if (!(PERF_AVAILABILITY_ZONES as readonly string[]).includes(props.nodeAvailabilityZone)) {
      throw new Error(`perf 노드 AZ는 ${PERF_AVAILABILITY_ZONES.join('|')} 중 하나여야 한다`);
    }
    this.vpc = new Vpc(this, 'PerfVpc', {
      ipAddresses: IpAddresses.cidr(props.vpcCidr),
      // AZ 조회 없이 합성되도록 명시한다. MSK broker 3대와 EKS control plane이 여러 AZ를 요구한다.
      availabilityZones: [...PERF_AVAILABILITY_ZONES],
      natGateways: props.natGateways,
      // NAT가 하나면 노드 AZ에 둔다. 노드 egress가 AZ를 건너지 않는다.
      natGatewaySubnets: props.natGateways === 1
        ? { subnetGroupName: PERF_SUBNET_GROUPS.public, availabilityZones: [props.nodeAvailabilityZone] }
        : { subnetGroupName: PERF_SUBNET_GROUPS.public },
      subnetConfiguration: [
        { name: PERF_SUBNET_GROUPS.public, subnetType: SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
        { name: PERF_SUBNET_GROUPS.private, subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        // broker ENI는 연결을 시작하지 않으므로 local route만 둔다(ADR-0035와 같은 방식).
        ...(props.kafkaProvider === 'strimzi' ? [] : [{ name: PERF_SUBNET_GROUPS.msk, subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }]),
      ],
    });
    this.natPublicIps = this.vpc.node.findAll().filter((node): node is CfnEIP => node instanceof CfnEIP).map(ip => ip.attrPublicIp);
    if (this.natPublicIps.length !== props.natGateways) throw new Error('perf NAT EIP 수가 설정과 다르다');
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetGroupName: PERF_SUBNET_GROUPS.private }],
    });

    const privateSubnets = this.vpc.selectSubnets({ subnetGroupName: PERF_SUBNET_GROUPS.private }).subnets;
    this.controlPlaneSubnets = privateSubnets;
    this.dataSubnets = privateSubnets;
    this.nodeSubnets = privateSubnets.filter(subnet => subnet.availabilityZone === props.nodeAvailabilityZone);
    this.mskSubnets = props.kafkaProvider === 'strimzi' ? [] : this.vpc.selectSubnets({ subnetGroupName: PERF_SUBNET_GROUPS.msk }).subnets;

    const sg = (name: string, description: string, allowAllOutbound = true) => new SecurityGroup(this, name, {
      vpc: this.vpc, description, allowAllOutbound, disableInlineRules: true,
    });
    this.controlPlaneSecurityGroup = sg('PerfEksControlPlaneSg', 'perf EKS control plane');
    this.relaySecurityGroup = sg('PerfEksRelaySg', 'perf EKS API SSM relay', false);
    this.nodeSecurityGroup = sg('PerfEksNodeSg', 'perf EKS nodes common');
    this.poolSecurityGroups = Object.fromEntries(this.poolIds.map(pool => [
      pool, sg(`PerfEks${pascal(pool)}PoolSg`, `perf EKS ${pool} node pool`),
    ])) as Record<PerfPoolId, SecurityGroup>;
    this.rdsSecurityGroup = sg('PerfRdsSg', 'perf RDS PostgreSQL', false);
    if (props.kafkaProvider !== 'strimzi') this.mskSecurityGroup = sg('PerfMskSg', 'perf MSK brokers', false);
    if (props.httpsGateway) {
      this.albSecurityGroup = sg('PerfAlbSg', 'perf HTTPS ALB from generator NAT only', false);
      for (const ip of this.natPublicIps) this.albSecurityGroup.addIngressRule(Peer.ipv4(`${ip}/32`), Port.tcp(443), 'HTTPS from perf NAT');
      this.albSecurityGroup.addEgressRule(this.poolSecurityGroups.gateway, Port.tcp(PERF_GATEWAY_NODE_PORT), 'Gateway target and health checks');
      this.poolSecurityGroups.gateway.addIngressRule(this.albSecurityGroup, Port.tcp(PERF_GATEWAY_NODE_PORT), 'HTTPS ALB to Gateway NodePort');
      this.poolSecurityGroups.system.addIngressRule(this.controlPlaneSecurityGroup, Port.tcp(9443), 'LBC admission webhook');
    }
    this.wire();
  }

  private wire(): void {
    const cp = this.controlPlaneSecurityGroup;
    const relay = this.relaySecurityGroup;
    const nodes = this.nodeSecurityGroup;
    const pools = this.poolSecurityGroups;
    const p = PERF_PORTS;

    // relay는 NAT로 SSM과 private Kubernetes API의 HTTPS만 쓴다(ADR-0034와 같은 방식).
    relay.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS to SSM and EKS API');
    cp.addIngressRule(relay, Port.tcp(443), 'Kubernetes API from SSM relay');
    cp.addIngressRule(nodes, Port.tcp(443), 'Kubernetes API from nodes');
    nodes.addIngressRule(cp, Port.tcp(p.kubelet), 'Kubelet and admission webhooks from control plane');
    nodes.addIngressRule(nodes, Port.udp(p.dns), 'Cluster DNS between nodes');
    nodes.addIngressRule(nodes, Port.tcp(p.dns), 'Cluster DNS TCP between nodes');
    for (const [port, what] of [[p.kubelet, 'Kubelet'], [p.nodeExporter, 'Node exporter'], [p.fluentBitMetrics, 'Fluent Bit']] as const) {
      nodes.addIngressRule(pools.observability, Port.tcp(port), `${what} metrics from observability`);
    }
    for (const pool of this.poolIds) pools[pool].addIngressRule(pools[pool], Port.allTraffic(), 'Same node pool communication');

    // 부하는 generator → Gateway다. system pool의 readiness smoke Job은 golden 6건만 보낸다. runner에는 MSK·DB 경로를 열지 않는다.
    pools.gateway.addIngressRule(pools.generator, Port.tcp(p.gateway), 'OTLP load from generator');
    pools.gateway.addIngressRule(pools.system, Port.tcp(p.gateway), 'Readiness smoke from system pool');
    pools.observability.addIngressRule(pools.generator, Port.tcp(p.prometheus), 'k6 remote-write from generator');
    pools.observability.addIngressRule(pools.system, Port.tcp(p.prometheus), 'Prometheus query from verifier');
    for (const pool of ['gateway', 'pipeline'] as const) {
      pools[pool].addIngressRule(pools.observability, Port.tcp(p.appMetrics), 'Application metrics from observability');
    }
    pools.clickhouse.addIngressRule(pools.pipeline, Port.tcp(p.clickhouseHttp), 'ClickHouse HTTP from pipeline');
    pools.clickhouse.addIngressRule(pools.pipeline, Port.tcp(p.clickhouseNative), 'ClickHouse native from pipeline');
    pools.clickhouse.addIngressRule(pools.system, Port.tcp(p.clickhouseHttp), 'ClickHouse HTTP from sentinel and verifier');
    pools.clickhouse.addIngressRule(pools.observability, Port.tcp(p.clickhouseMetrics), 'ClickHouse metrics from observability');

    // enrollment·seed·prepare는 system pool, Consumer는 pipeline pool에서 RDS에 접속한다.
    for (const pool of ['pipeline', 'system'] as const) {
      this.rdsSecurityGroup.addIngressRule(pools[pool], Port.tcp(p.postgres), `Postgres from ${pool} pool`);
    }
    if (this.mskSecurityGroup) {
    // Gateway·Consumer·topic 관리 Job만 9098로 접속한다. Open Monitoring은 관측 pool만 받는다.
    for (const pool of ['gateway', 'pipeline', 'system'] as const) {
      this.mskSecurityGroup.addIngressRule(pools[pool], Port.tcp(PERF_MSK_IAM_PORT), `MSK IAM from ${pool} pool`);
    }
    for (const port of [p.mskJmxExporter, p.mskNodeExporter]) {
      this.mskSecurityGroup.addIngressRule(pools.observability, Port.tcp(port), 'MSK Open Monitoring from observability');
    }
    } else {
      // Operator는 system pool, clients는 gateway/pipeline/system이다. runner에는 Kafka 경로가 없다.
      for (const pool of ['gateway', 'pipeline', 'system'] as const) pools.kafka.addIngressRule(pools[pool], Port.tcp(9093), `Kafka mTLS from ${pool}`);
      for (const port of [9090, 9091, 8443]) pools.kafka.addIngressRule(pools.system, Port.tcp(port), 'Strimzi operator control');
      pools.kafka.addIngressRule(pools.observability, Port.tcp(9404), 'Kafka JMX metrics');
      for (const port of [9404, 8080, 8081]) pools.system.addIngressRule(pools.observability, Port.tcp(port), 'Strimzi operator and exporter metrics');
    }
  }
}

function pascal(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
