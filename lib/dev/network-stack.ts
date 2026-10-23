import { Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  CfnSecurityGroupIngress,
  GatewayVpcEndpointAwsService,
  IpAddresses,
  IPeer,
  Peer,
  Port,
  PrivateSubnet,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { PORTS } from '../common/config';
import { DEV_EKS_NODE_PORTS, DEV_EKS_MSK_SUBNETS, DEV_EKS_MSK_IAM_PORT } from './eks-config';
import {
  DEV_SUBNET_GROUP,
  DEV_VPC_CIDR,
  warnOnOpenIngress,
} from './config';

export interface DevNetworkStackProps extends StackProps {
  readonly eksHttpsEnabled?: boolean;
  /**
   * 앱 ALB(80/선택적 443)의 인바운드 허용 소스.
   */
  readonly allowedCidrs: readonly string[];
}

/**
 * dev VPC·RDS/EKS/DB 릴레이 SG 아홉 개와 모든 cross-SG 규칙을 소유한다.
 * 기존 EKS construct ID와 GroupDescription을 보존한다. (ADR-0035)
 */
export class DevNetworkStack extends Stack {
  public readonly eksControlPlaneSecurityGroup: SecurityGroup;
  public readonly eksAppNodeSecurityGroup: SecurityGroup;
  public readonly eksClickhouseNodeSecurityGroup: SecurityGroup;
  public readonly eksValidationAlbSecurityGroup: SecurityGroup;
  public readonly eksRelaySecurityGroup: SecurityGroup;
  public readonly dbRelaySecurityGroup: SecurityGroup;
  public readonly eksObservabilityNodeSecurityGroup: SecurityGroup;
  public readonly mskSubnets: readonly PrivateSubnet[];
  public readonly mskSecurityGroup: SecurityGroup;
  public readonly vpc: Vpc;
  public readonly rdsSecurityGroup: SecurityGroup;

  private readonly allowedCidrs: readonly string[];

  constructor(scope: Construct, id: string, props: DevNetworkStackProps) {
    super(scope, id, props);

    this.allowedCidrs = props.allowedCidrs;

    // 기본값(0.0.0.0/0)이 그대로 쓰이면 여기서 경고를 낸다. 아래 인바운드 룰이
    // 실제로 인터넷을 향해 열리는 자리이므로 경고도 같은 스택에 둔다.
    warnOnOpenIngress(this, this.allowedCidrs);

    this.vpc = new Vpc(this, 'DevVpc', {
      // 운영 VPC(CDK 기본 10.0.0.0/16)와 겹치지 않게 둔다. (ADR-0022 1번)
      ipAddresses: IpAddresses.cidr(DEV_VPC_CIDR),
      // 이중화가 아니라 하드 제약이다 - internet-facing ALB 가 최소 2개 AZ 의
      // 퍼블릭 서브넷을 요구하고, RDS DB subnet group 도 2 AZ 를 요구한다.
      // 워크로드는 여전히 사실상 1 AZ 에 몰린다. (ADR-0011 과 같은 이유)
      maxAzs: 2,
      // NAT 를 두지 않는다(월 약 $35 절감). 그 결과 `PRIVATE_WITH_EGRESS` 서브넷을
      // 만들 수 없으므로 - egress 경로가 없으면 CDK 가 합성 단계에서 거부한다 -
      // 서브넷 타입은 PUBLIC 하나만 남는다. 티켓의 두 제약("퍼블릭 서브넷",
      // "NAT 없음")은 사실 하나의 제약이다. (ADR-0022 1번)
      natGateways: 0,
      subnetConfiguration: [
        {
          name: DEV_SUBNET_GROUP.public,
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // 기존 S3 Gateway endpoint를 보존한다.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });

    // GroupDescription은 교체 속성이므로 기존 문자열을 유지한다.
    this.rdsSecurityGroup = new SecurityGroup(this, 'DevRdsSg', {
      vpc: this.vpc,
      description: 'dev RDS PostgreSQL (publicly accessible)',
      allowAllOutbound: true,
    });

    const sg = (name: string, description: string) => new SecurityGroup(this, name, {
      vpc: this.vpc, description, allowAllOutbound: true, disableInlineRules: true,
    });
    this.eksControlPlaneSecurityGroup = sg('DevEksControlPlaneSg', 'dev EKS control plane');
    this.eksAppNodeSecurityGroup = sg('DevEksAppNodeSg', 'dev EKS application nodes');
    this.eksClickhouseNodeSecurityGroup = sg('DevEksClickhouseNodeSg', 'dev EKS ClickHouse nodes');
    this.eksObservabilityNodeSecurityGroup = sg('DevEksObservabilityNodeSg', 'dev EKS observability nodes');
    this.eksValidationAlbSecurityGroup = sg('DevEksValidationAlbSg', 'dev EKS validation ALB');
    this.eksRelaySecurityGroup = new SecurityGroup(this, 'DevEksRelaySg', {
      vpc: this.vpc, description: 'dev EKS API SSM relay',
      allowAllOutbound: false, disableInlineRules: true,
    });
    // NAT 없는 public subnet에서 SSM과 private Kubernetes API의 HTTPS만 사용한다.
    this.eksRelaySecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS to SSM and EKS API');
    this.eksControlPlaneSecurityGroup.addIngressRule(this.eksRelaySecurityGroup, Port.tcp(443), 'Kubernetes API from SSM relay');
    this.dbRelaySecurityGroup = new SecurityGroup(this, 'DevDbRelaySg', {
      vpc: this.vpc, description: 'dev database SSM relay',
      allowAllOutbound: false, disableInlineRules: true,
    });
    this.dbRelaySecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS to SSM');
    this.dbRelaySecurityGroup.addEgressRule(this.rdsSecurityGroup, Port.tcp(PORTS.aurora), 'Postgres through DB relay');
    this.dbRelaySecurityGroup.addEgressRule(this.eksClickhouseNodeSecurityGroup, Port.tcp(PORTS.clickhouseHttp), 'ClickHouse through DB relay');
    // 기존 RDS SG의 inline 구성을 바꾸지 않고 SG peer 규칙을 별도로 소유한다.
    new CfnSecurityGroupIngress(this, 'DbRelayToRds', {
      groupId: this.rdsSecurityGroup.securityGroupId, sourceSecurityGroupId: this.dbRelaySecurityGroup.securityGroupId,
      ipProtocol: 'tcp', fromPort: PORTS.aurora, toPort: PORTS.aurora, description: 'Postgres from DB relay',
    });
    this.eksClickhouseNodeSecurityGroup.addIngressRule(this.dbRelaySecurityGroup, Port.tcp(PORTS.clickhouseHttp), 'ClickHouse HTTP from DB relay');
    const cp = this.eksControlPlaneSecurityGroup;
    const apps = this.eksAppNodeSecurityGroup;
    const ch = this.eksClickhouseNodeSecurityGroup;
    const validation = this.eksValidationAlbSecurityGroup;
    const obs = this.eksObservabilityNodeSecurityGroup;
    for (const nodes of [apps, ch, obs]) {
      cp.addIngressRule(nodes, Port.tcp(443), 'Kubernetes API from nodes');
      nodes.addIngressRule(cp, Port.tcp(10250), 'Kubelet from control plane');
      nodes.addIngressRule(nodes, Port.allTraffic(), 'Same node pool communication');
    }
    apps.addIngressRule(cp, Port.tcp(9443), 'LBC admission webhook');
    obs.addIngressRule(cp, Port.tcp(10250), 'Prometheus operator admission webhook');
    for (const nodes of [apps, ch]) {
      nodes.addIngressRule(obs, Port.tcp(10250), 'Kubelet metrics from observability');
      nodes.addIngressRule(obs, Port.tcp(2020), 'Fluent Bit metrics from observability');
      nodes.addIngressRule(obs, Port.tcp(9100), 'Node exporter metrics from observability');
    }
    apps.addIngressRule(obs, Port.tcp(9404), 'Application metrics from observability');
    ch.addIngressRule(obs, Port.tcp(9363), 'ClickHouse metrics from observability');
    // kube-dns가 앱 노드에 배치되어도 관측 Pod의 이름 조회가 동작한다.
    apps.addIngressRule(obs, Port.udp(53), 'Cluster DNS from observability');
    apps.addIngressRule(obs, Port.tcp(53), 'Cluster DNS TCP from observability');
    ch.addIngressRule(apps, Port.tcp(8123), 'ClickHouse HTTP from EKS applications');
    ch.addIngressRule(apps, Port.tcp(9000), 'ClickHouse native from EKS applications');
    for (const alb of [validation]) {
      apps.addIngressRule(alb, Port.tcp(30416), 'EKS ingest NodePort from ALB');
      apps.addIngressRule(alb, Port.tcp(30080), 'EKS enrollment NodePort from ALB');
      apps.addIngressRule(alb, Port.tcp(DEV_EKS_NODE_PORTS.dashboard), 'EKS dashboard NodePort from ALB');
      apps.addIngressRule(alb, Port.tcp(DEV_EKS_NODE_PORTS.gateway), 'EKS telemetry gateway NodePort from ALB');
    }
    this.forEachAllowedCidr((peer, cidr) => {
      validation.addIngressRule(peer, Port.tcp(80), `Validation HTTP from ${cidr}`);
      if (props.eksHttpsEnabled) {
        validation.addIngressRule(peer, Port.tcp(PORTS.https), `Validation HTTPS from ${cidr}`);
      }
    });
    // VPC construct와 maxAzs: 2를 바꾸지 않고 MSK broker 전용 subnet만 추가한다. local route만 있으며
    // IGW·NAT·S3 endpoint route를 연결하지 않는다. VPC의 subnet 선택에도 들어가지 않는다. (ADR-0035)
    this.mskSubnets = DEV_EKS_MSK_SUBNETS.map((subnet, index) => new PrivateSubnet(this, `DevMskSubnet${index + 1}`, {
      vpcId: this.vpc.vpcId, availabilityZone: subnet.availabilityZone,
      cidrBlock: subnet.cidrBlock, mapPublicIpOnLaunch: false,
    }));
    // broker ENI는 연결을 시작하지 않는다. 앱 NodePool의 Gateway·Consumer·관리 Job만 9098로 접속한다.
    this.mskSecurityGroup = new SecurityGroup(this, 'DevMskSg', {
      vpc: this.vpc, description: 'dev MSK brokers', allowAllOutbound: false, disableInlineRules: true,
    });
    this.mskSecurityGroup.addIngressRule(apps, Port.tcp(DEV_EKS_MSK_IAM_PORT), 'MSK IAM from EKS applications');
    for (const port of [11001, 11002]) this.mskSecurityGroup.addIngressRule(obs, Port.tcp(port), 'MSK Open Monitoring from observability');
    // 기존 SG의 inline properties를 바꾸지 않고 별도 규칙을 추가한다.
    new CfnSecurityGroupIngress(this, 'EksToRds', {
      groupId: this.rdsSecurityGroup.securityGroupId, sourceSecurityGroupId: apps.securityGroupId,
      ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, description: 'Postgres from EKS applications',
    });

  }

  /**
   * 허용 CIDR 마다 룰을 건다.
   *
   * CIDR peer 룰은 SG 리소스의 인라인 `SecurityGroupIngress` 로 합성되고 그 키에
   * description 이 포함되므로, description 에 CIDR 을 넣어 여러 개를 줘도 항목이
   * 겹치지 않게 한다.
   */
  private forEachAllowedCidr(
    fn: (peer: IPeer, cidr: string) => void,
  ): void {
    for (const cidr of this.allowedCidrs) {
      fn(Peer.ipv4(cidr), cidr);
    }
  }
}
