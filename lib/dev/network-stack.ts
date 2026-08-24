import { Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  GatewayVpcEndpointAwsService,
  IpAddresses,
  IPeer,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { PORTS } from '../common/config';
import {
  DEV_SUBNET_GROUP,
  DEV_VPC_CIDR,
  warnOnOpenIngress,
} from './config';

/**
 * ECS bridge 모드에서 `hostPort` 를 지정하지 않으면 ECS 가 이 범위에서 호스트 포트를
 * 골라 컨테이너 포트에 매핑한다(ephemeral port range). ALB 인스턴스 타깃은 그 동적
 * 포트로 등록되므로, ALB 와 운영자가 호스트에 닿으려면 이 범위 전체를 열어야 한다.
 *
 * `DevDashboardTask` 가 bridge 인 한 이 상수는 지울 수 없다. (ADR-0022 4번)
 */
const EPHEMERAL_PORT_MIN = 32768;
const EPHEMERAL_PORT_MAX = 65535;

export interface DevNetworkStackProps extends StackProps {
  /**
   * ALB(80/4318/8123)와 RDS(5432), 호스트 동적 포트의 인바운드 허용 소스.
   * 4318 은 인증을 우회하는 Collector 디버그 리스너다 (ADR-0023 3번).
   */
  readonly allowedCidrs: readonly string[];
}

/**
 * DevNetworkStack: dev 전용 VPC(퍼블릭 서브넷 전용, NAT 없음) + S3 게이트웨이
 * 엔드포인트 + SG 5개 전부.
 *
 * **SG 5개와 모든 cross-SG 룰을 이 스택에만 둔다.** `AGENTS.md` 3장의 불변 규칙을
 * dev 에 그대로 계승한 것이다 - SG 간 참조가 스택 내부 참조가 되어 스택 간 순환
 * 의존을 원천 차단하고, 하류 스택(`DevDataStack`, `DevApplicationStack`,
 * `DevEdgeStack`)은 props 로 주입만 받는다. 이 성질은 환경과 무관하다. (ADR-0022 2번)
 *
 * 하류 스택에서 `connections.allowFrom(...)` 이 같은 규칙을 다시 요청해도 CDK 가
 * 같은 construct ID 로 dedup 하므로 추가 리소스가 생기지 않는다 - 여기에 미리
 * 정의해 두는 것이 그 dedup 의 전제다. 운영도 같은 구조다.
 */
export class DevNetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly albSecurityGroup: SecurityGroup;
  /** EC2 호스트 2대(앱 ASG + ClickHouse ASG) 공용 SG. */
  public readonly appHostSecurityGroup: SecurityGroup;
  /** collector 태스크 ENI(awsvpc)용 SG. */
  public readonly collectorSecurityGroup: SecurityGroup;
  /** ClickHouse 태스크 ENI(awsvpc)용 SG. */
  public readonly clickhouseSecurityGroup: SecurityGroup;
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

    // 게이트웨이 엔드포인트는 요금이 없다. 그리고 awsvpc 태스크(collector,
    // ClickHouse)의 ENI 에는 퍼블릭 IP 가 붙지 않고 NAT 도 없으므로, 이것이
    // 태스크가 S3 에 닿는 **유일한 경로**다. (ADR-0022 1번/5(a))
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });

    // **이 `description` 문자열을 다시는 건드리지 않는다.**
    //
    // `AWS::EC2::SecurityGroup` 의 `GroupDescription` 은 CloudFormation 상
    // `Update requires: Replacement` 다. 한 글자만 고쳐도 CFN 이 새 SG 를 만들고
    // 기존 SG 를 지우려 하는데, **ALB 는 `DevEdgeStack` 에 있어 같은 배포에서 함께
    // 갱신되지 않는다.** 그 사이 ALB 가 옛 SG 를 계속 쓰고 있으므로 삭제가
    // `DependencyViolation: resource sg-... has a dependent object` 로 실패하고,
    // CFN 은 이를 스택 실패로 처리하지 않고 **"Update successful. One or more
    // resources could not be deleted." 로 UPDATE_COMPLETE 를 낸다** - 즉 조용히
    // 고아 SG 하나가 남는다.
    //
    // **ADR-0023 구현 때 여기에 4318 을 추가했다가 실제로 이렇게 깨졌다**
    // (sg-085990faedba1dbd2 가 고아로 남음). 그래서 이 문자열은 현재 배포된 값과
    // 일치시켜 두는 것이 유일하게 안전한 상태다 - 지금 와서 "정확하게" 고치려 들면
    // 교체가 한 번 더 일어나 고아가 하나 더 생긴다.
    //
    // 포트 구성이 바뀌면 설명이 아니라 아래 `wireSecurityGroupRules()` 의 주석으로
    // 남긴다. 실제 인바운드는 그쪽이 권위다.
    this.albSecurityGroup = new SecurityGroup(this, 'DevAlbSg', {
      vpc: this.vpc,
      description: 'dev ALB - inbound 80/4318/8123 from allowed CIDRs',
      allowAllOutbound: true,
    });
    this.appHostSecurityGroup = new SecurityGroup(this, 'DevAppHostSg', {
      vpc: this.vpc,
      description: 'dev ECS EC2 hosts (app ASG + ClickHouse ASG)',
      allowAllOutbound: true,
    });
    this.collectorSecurityGroup = new SecurityGroup(this, 'DevCollectorSg', {
      vpc: this.vpc,
      description: 'dev Collector task ENI (awsvpc)',
      allowAllOutbound: true,
    });
    this.clickhouseSecurityGroup = new SecurityGroup(this, 'DevClickhouseSg', {
      vpc: this.vpc,
      description: 'dev ClickHouse task ENI (awsvpc)',
      allowAllOutbound: true,
    });
    this.rdsSecurityGroup = new SecurityGroup(this, 'DevRdsSg', {
      vpc: this.vpc,
      description: 'dev RDS PostgreSQL (publicly accessible)',
      allowAllOutbound: true,
    });

    this.wireSecurityGroupRules();
  }

  private wireSecurityGroupRules(): void {
    const ephemeralPorts = Port.tcpRange(
      EPHEMERAL_PORT_MIN,
      EPHEMERAL_PORT_MAX,
    );

    // ALB <- 허용 CIDR : 80(OTLP + API), 8123(ClickHouse 직접 쿼리).
    this.forEachAllowedCidr((peer, cidr) => {
      this.albSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.http),
        `HTTP from ${cidr}`,
      );
      this.albSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.clickhouseHttp),
        `ClickHouse HTTP from ${cidr}`,
      );
      // 4318 은 인증을 거치지 않고 Collector 로 직행하는 디버그 리스너다
      // (ADR-0023 3번). auth-proxy 가 죽었는지 파이프라인이 죽었는지를 가르는 용도이며,
      // **인증 우회 경로이므로** 허용 CIDR 이 곧 유일한 방어선이다. 기본값
      // 0.0.0.0/0 이면 `infra:dev-open-ingress` 경고가 이 리스너까지 함께 커버한다.
      this.albSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.otlp),
        `OTLP debug from ${cidr}`,
      );
    });

    // 앱 호스트 <- ALB : bridge 태스크(dashboard)의 동적 호스트 포트.
    this.appHostSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ephemeralPorts,
      'Dynamic host ports from ALB (bridge tasks)',
    );
    // 앱 호스트 <- 허용 CIDR : ALB 를 거치지 않고 호스트에 직접 curl 을 던져
    // 디버깅할 수 있게 둔다. 호스트 접속 자체는 SSM 이지만(ADR-0022 5(b)),
    // 로컬에서 바로 찔러보는 경로가 dev 의 존재 이유다.
    this.forEachAllowedCidr((peer, cidr) => {
      this.appHostSecurityGroup.addIngressRule(
        peer,
        ephemeralPorts,
        `Dynamic host ports from ${cidr}`,
      );
    });

    // Collector 태스크 ENI <- ALB:4318. 이제 정상 경로(:80 /v1/*)가 아니라
    // **디버그 리스너(:4318)** 가 쓰는 룰이다. 정상 트래픽은 ALB -> auth-proxy ->
    // Collector 로 가며, 그 마지막 홉의 룰은 바로 아래다. (ADR-0023 3번)
    this.collectorSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      Port.tcp(PORTS.otlp),
      'OTLP from ALB',
    );

    // Collector 태스크 ENI <- 앱 호스트:4318 (auth-proxy -> Collector).
    //
    // **출발 SG 가 앱 호스트 SG 인 이유는 `DevAuthProxyTask` 가 bridge 이기 때문이다.**
    // bridge 태스크는 자기 ENI 가 없어 아웃바운드가 호스트 ENI 를 타므로, 출발 SG 는
    // 태스크 SG 가 아니라 `DevAppHostSg` 다. 바로 아래 ClickHouse 룰이 batch-processor
    // 때문에 같은 형태인 것과 정확히 같은 사정이다. 이 룰을 "쓰지 않는 것 같다"고
    // 지우면 auth-proxy 만 조용히 타임아웃으로 죽는다.
    //
    // 대가로 같은 호스트의 dashboard 태스크도 4318 에 닿을 수 있다. bridge 를 고른
    // 트레이드오프이며 ADR-0023 Negative 에 기록되어 있다. (ADR-0022 4번, ADR-0023 2번)
    this.collectorSecurityGroup.addIngressRule(
      this.appHostSecurityGroup,
      Port.tcp(PORTS.otlp),
      'OTLP from app hosts (bridge auth-proxy)',
    );

    // ClickHouse 태스크 ENI <- {collector 태스크 ENI, 앱 호스트} : 8123/9000.
    //
    // **앱 호스트 SG 가 peer 에 들어가는 이유는 `DevDashboardTask` 가 bridge 이기
    // 때문이다.** bridge 태스크는 자기 ENI 가 없어 아웃바운드가 호스트 ENI 를
    // 타므로, batch-processor 가 ClickHouse 로 보내는 트래픽의 출발 SG 는 태스크
    // SG 가 아니라 `DevAppHostSg` 다. 이 룰을 "쓰지 않는 것 같다"고 지우면
    // batch-processor 만 조용히 타임아웃으로 죽는다. (ADR-0022 4번)
    for (const peer of [
      this.collectorSecurityGroup,
      this.appHostSecurityGroup,
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
    // ClickHouse 태스크 ENI <- ALB:8123. EC2 퍼블릭 IP 가 인스턴스 교체마다 바뀌므로
    // (ADR-0010 과 같은 사정) ALB :8123 리스너가 안정적인 직접 쿼리 주소를 준다.
    this.clickhouseSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      Port.tcp(PORTS.clickhouseHttp),
      'ClickHouse HTTP from ALB (debug listener)',
    );

    // RDS <- {collector 태스크 ENI, 앱 호스트} : 5432.
    // 앱 호스트가 필요한 이유는 위 ClickHouse 와 같다 - api-server 가 bridge 라
    // Postgres 연결의 출발 SG 가 호스트 ENI 다.
    for (const peer of [
      this.collectorSecurityGroup,
      this.appHostSecurityGroup,
    ]) {
      this.rdsSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.aurora),
        'Postgres from app tier',
      );
    }
    // RDS <- 허용 CIDR : 로컬 psql 직접 접속. `publiclyAccessible: true` 와 한 몸이며
    // (ADR-0022 6번) `AGENTS.md` 5장 (H)의 "RDS 조직 스키마를 아무도 부트스트랩하지
    // 않는다"를 dev 에서 손으로 해결할 수 있는 유일한 경로다.
    this.forEachAllowedCidr((peer, cidr) => {
      this.rdsSecurityGroup.addIngressRule(
        peer,
        Port.tcp(PORTS.aurora),
        `Postgres from ${cidr}`,
      );
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
