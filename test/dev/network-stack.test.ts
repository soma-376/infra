import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { DEV_VPC_CIDR } from '../../lib/dev/config';
import { PORTS } from '../../lib/common/config';
import { buildDevApp } from '../helpers';

/**
 * SG 인그레스 항목을 한곳에 모은다.
 *
 * CIDR peer 룰은 SG 리소스의 인라인 `SecurityGroupIngress` 로, SG peer 룰은 별도
 * `AWS::EC2::SecurityGroupIngress` 리소스로 합성되므로 양쪽을 함께 본다.
 * **라우트 테이블의 `DestinationCidrBlock: 0.0.0.0/0` 은 인그레스가 아니므로
 * 여기 섞이지 않는다** - 전면 공개 회귀를 잡으려면 이 구분이 필요하다.
 */
function allIngressRules(template: Template): any[] {
  const inline = Object.values(
    template.findResources('AWS::EC2::SecurityGroup'),
  ).flatMap(
    (resource: any) => resource.Properties.SecurityGroupIngress ?? [],
  );
  const standalone = Object.values(
    template.findResources('AWS::EC2::SecurityGroupIngress'),
  ).map((resource: any) => resource.Properties);

  return [...inline, ...standalone];
}

describe('DevNetworkStack', () => {
  const { network } = buildDevApp();
  const template = Template.fromStack(network);

  // NAT 가 없다는 것이 이 환경의 비용 전제이자 토폴로지 전제다. 하나라도 생기면
  // 월 약 $35 가 조용히 붙고, 동시에 "퍼블릭 서브넷 전용"이라는 설계도 깨진다.
  // (ADR-0022 1번)
  test('NAT gateway 를 하나도 만들지 않는다', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  // 운영 VPC(CDK 기본 10.0.0.0/16)와 겹치면 두 VPC 를 peering 하거나 같은 VPN 에
  // 물릴 여지가 영구히 사라진다. (ADR-0022 1번)
  test('VPC CIDR 이 운영과 겹치지 않는 10.1.0.0/16 이다', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: DEV_VPC_CIDR,
    });
    expect(DEV_VPC_CIDR).not.toBe('10.0.0.0/16');
  });

  // NAT 0 + 서브넷 2개 + 전부 MapPublicIpOnLaunch 조합이 "public 한 티어만 있다"를
  // 증명한다. 프라이빗 서브넷이 끼어들면 셋 중 하나는 반드시 깨진다.
  test('서브넷은 2 AZ x public 1 티어 = 2개이고 전부 퍼블릭이다', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 2);

    const subnets = Object.values(template.findResources('AWS::EC2::Subnet'));
    expect(
      subnets.map((subnet: any) => subnet.Properties.MapPublicIpOnLaunch),
    ).toEqual([true, true]);
  });

  // awsvpc 태스크의 ENI 에는 퍼블릭 IP 가 붙지 않고 NAT 도 없으므로, 이 엔드포인트가
  // 태스크가 S3 에 닿는 유일한 경로다. (ADR-0022 1번/5(a))
  test('S3 게이트웨이 VPC 엔드포인트가 있다', () => {
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });

  test('SG 5개를 모두 이 스택에서 정의한다', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 5);
  });

  // **auth-proxy -> Collector 의 유일한 통로다.** auth-proxy 는 bridge 라 자기 ENI 가
  // 없고 아웃바운드가 호스트 ENI 를 타므로, 출발 SG 가 태스크 SG 가 아니라
  // DevAppHostSg 다. 이 룰을 "아무도 안 쓰는 것 같다"고 지우면 **synth·test·deploy 가
  // 전부 통과하고** auth-proxy 만 런타임에 upstream_unreachable 로 죽는다 -
  // ALB 헬스체크는 /health 만 보므로 타깃은 계속 healthy 로 남는다.
  // (ADR-0022 4번, ADR-0023 2번)
  test('Collector SG 는 앱 호스트 SG 에서 4318 을 받는다 (bridge auth-proxy)', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: PORTS.otlp,
      ToPort: PORTS.otlp,
      IpProtocol: 'tcp',
      Description: 'OTLP from app hosts (bridge auth-proxy)',
      GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('DevCollectorSg'), 'GroupId'] },
      SourceSecurityGroupId: {
        'Fn::GetAtt': [Match.stringLikeRegexp('DevAppHostSg'), 'GroupId'],
      },
    });
  });

  // 기본값이 그대로 쓰이면 유일한 방어선은 이 경고뿐이다. 메시지가 아니라
  // addWarningV2 의 ack ID(`[ack: infra:dev-open-ingress]` 로 합성 메시지 끝에
  // 붙는다)를 매칭한다 - ID 를 바꾸면 기존 acknowledge 가 무효가 되기 때문이다.
  test('devAllowedCidr 미지정이면 infra:dev-open-ingress 경고를 낸다', () => {
    Annotations.fromStack(network).hasWarning(
      '*',
      Match.stringLikeRegexp('infra:dev-open-ingress'),
    );
  });
});

describe('DevNetworkStack - devAllowedCidr 로 인바운드를 좁힌 경우', () => {
  const allowedCidr = '203.0.113.10/32';
  const { network } = buildDevApp({ devAllowedCidr: allowedCidr });
  const template = Template.fromStack(network);

  // 4318 은 auth-proxy 를 우회해 Collector 로 직행하는 디버그 리스너다. 인증이 없는
  // 경로이므로 이 CIDR 이 곧 유일한 방어선이며, 목록에서 빠지면 리스너만 살아 있고
  // 인그레스가 없어 조용히 타임아웃된다. (ADR-0023 3번)
  test('ALB SG 는 지정 CIDR 에서 80, 4318, 8123 을 받는다', () => {
    for (const port of [PORTS.http, PORTS.otlp, PORTS.clickhouseHttp]) {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        // **이 문자열을 고치는 PR 은 반려 대상이다.** GroupDescription 은 CFN 상
        // Replacement 속성이라, 바꾸면 SG 교체 -> ALB(다른 스택)가 옛 SG 를 붙들고
        // 있어 DependencyViolation -> 고아 SG 가 남는다. 이 어서션은 값이 맞는지가
        // 아니라 **아무도 값을 바꾸지 않았는지**를 지킨다. (lib 쪽 주석 참조)
        GroupDescription: 'dev ALB - inbound 80/4318/8123 from allowed CIDRs',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            CidrIp: allowedCidr,
            FromPort: port,
            ToPort: port,
            IpProtocol: 'tcp',
          }),
        ]),
      });
    }
  });

  // publiclyAccessible RDS 의 접근 통제는 전적으로 이 룰에 달려 있다. (ADR-0022 6번)
  test('RDS SG 는 지정 CIDR 에서 5432 를 받는다', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'dev RDS PostgreSQL (publicly accessible)',
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          CidrIp: allowedCidr,
          FromPort: PORTS.aurora,
          ToPort: PORTS.aurora,
          IpProtocol: 'tcp',
        }),
      ]),
    });
  });

  // **이 어서션이 `open: false` 회귀를 잡는 자리다.** DevEdgeStack 의 addListener 에서
  // `open: false` 를 빼면 CDK 가 리스너 포트를 0.0.0.0/0 에 여는 인그레스를 ALB SG 에
  // 자동으로 추가하고, 그 룰이 좁힌 룰 옆에 남아 전면 공개로 되돌린다. 그러면
  // devAllowedCidr 을 지정한 의미가 통째로 사라진다. (ADR-0022 2번/9번)
  test('CIDR 을 지정하면 전면 공개 인그레스가 어디에도 남지 않는다', () => {
    const open = allIngressRules(template).filter(
      (rule) => rule.CidrIp === '0.0.0.0/0',
    );
    expect(open).toEqual([]);
  });

  test('CIDR 을 지정하면 open-ingress 경고를 내지 않는다', () => {
    Annotations.fromStack(network).hasNoWarning(
      '*',
      Match.stringLikeRegexp('infra:dev-open-ingress'),
    );
  });
});

describe('DevNetworkStack - devAllowedCidr 을 여러 개 준 경우', () => {
  // 공백 포함 입력이 사람의 기본 습관이다. 여기까지 통과해야 손잡이가 실제로 쓸모 있다.
  const { network } = buildDevApp({
    devAllowedCidr: '203.0.113.10/32, 198.51.100.0/24',
  });
  const template = Template.fromStack(network);

  // 포트마다 arrayWith 를 따로 건다. **`Match.arrayWith` 는 순서를 지키는 부분열
  // 매칭이라** 한 번에 여러 개를 넣으면 룰을 거는 순서가 어서션 순서와 같아야만
  // 통과한다 - 그 결합은 테스트가 검증하려는 계약과 무관하다.
  test('ALB SG 인그레스에 두 CIDR 이 모두 들어간다', () => {
    for (const cidr of ['203.0.113.10/32', '198.51.100.0/24']) {
      for (const port of [PORTS.http, PORTS.otlp, PORTS.clickhouseHttp]) {
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
          // **이 문자열을 고치는 PR 은 반려 대상이다.** GroupDescription 은 CFN 상
        // Replacement 속성이라, 바꾸면 SG 교체 -> ALB(다른 스택)가 옛 SG 를 붙들고
        // 있어 DependencyViolation -> 고아 SG 가 남는다. 이 어서션은 값이 맞는지가
        // 아니라 **아무도 값을 바꾸지 않았는지**를 지킨다. (lib 쪽 주석 참조)
        GroupDescription: 'dev ALB - inbound 80/4318/8123 from allowed CIDRs',
          SecurityGroupIngress: Match.arrayWith([
            Match.objectLike({ CidrIp: cidr, FromPort: port }),
          ]),
        });
      }
    }
  });
});
