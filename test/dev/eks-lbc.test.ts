import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { load, loadAll } from 'js-yaml';
import { App, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DevEksLbc } from '../../lib/dev/eks-lbc';
import { TEST_ENV } from '../helpers';

const clusterName = 'soma-376-dev-eks';
const lbcPath = path.join(__dirname, '../../helm/dev/platform/lbc');

// 단일 construct의 IAM 경계를 검사한다. 실제 활성화된 dev 스택의 조립은 eks-stack suite가 검사한다.
function lbcTemplate(namespace?: string): Template {
  const cdkContext = JSON.parse(fs.readFileSync(path.join(__dirname, '../../cdk.json'), 'utf8')).context ?? {};
  const app = new App({ context: cdkContext });
  const stack = new Stack(app, 'LbcFixture', { env: TEST_ENV });
  new DevEksLbc(stack, 'Lbc', { clusterName, namespace });
  return Template.fromStack(stack);
}

describe('dev EKS LBC Pod Identity와 외부 TG 소유권', () => {
  test('Pod Identity trust를 같은 cluster ARN·namespace·ServiceAccount로 제한한다', () => {
    const template = lbcTemplate();
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({
          Action: ['sts:AssumeRole', 'sts:TagSession'],
          Principal: { Service: 'pods.eks.amazonaws.com' },
          Condition: {
            StringEquals: {
              'aws:RequestTag/eks-cluster-arn':
                'arn:aws:eks:ap-northeast-2:111111111111:cluster/soma-376-dev-eks',
              'aws:RequestTag/kubernetes-namespace': 'kube-system',
              'aws:RequestTag/kubernetes-service-account': 'aws-load-balancer-controller',
            },
          },
        })],
      },
    });
    template.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      ClusterName: clusterName,
      Namespace: 'kube-system',
      ServiceAccount: 'aws-load-balancer-controller',
      DisableSessionTags: false,
    });
    template.hasOutput('EksLbcRoleArn', { Value: Match.anyValue() });
  });

  test('namespace override가 association과 trust 양쪽에 반영된다', () => {
    const template = lbcTemplate('lbc-system');
    template.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      Namespace: 'lbc-system',
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Condition: {
            StringEquals: Match.objectLike({
              'aws:RequestTag/kubernetes-namespace': 'lbc-system',
            }),
          },
        })]),
      },
    });
  });

  test('TG 이름 접두사·계정·리전과 CDK 소유 태그가 있어야 타깃을 등록·해제한다', () => {
    lbcTemplate().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([{
          Action: ['elasticloadbalancing:DeregisterTargets', 'elasticloadbalancing:RegisterTargets'],
          Effect: 'Allow',
          Resource: 'arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:targetgroup/soma-376-dev-eks-*/*',
          Condition: {
            StringEquals: {
              'aws:ResourceTag/pulsemetry:eks-cluster': clusterName,
              'aws:RequestedRegion': 'ap-northeast-2',
            },
          },
        }]),
      },
    });
  });

  test('target 등록과 필요한 조회만 허용하고 ALB/TG/listener·SG 쓰기를 허용하지 않는다', () => {
    const template = lbcTemplate();
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(resource => resource.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap(statement =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
    expect(actions.sort()).toEqual([
      'ec2:DescribeSecurityGroups',
      'ec2:DescribeVpcs',
      'elasticloadbalancing:DeregisterTargets',
      'elasticloadbalancing:DescribeTargetGroups',
      'elasticloadbalancing:DescribeTargetHealth',
      'elasticloadbalancing:RegisterTargets',
    ].sort());
    expect(statements.filter(statement => statement.Resource === '*')).toHaveLength(1);
    expect(statements.every(statement => statement.Condition.StringEquals['aws:RequestedRegion'] === TEST_ENV.region)).toBe(true);
    const resources = Object.values(template.toJSON().Resources).map(resource => (resource as { Type: string }).Type);
    expect(resources.every(type => ['AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::EKS::PodIdentityAssociation'].includes(type))).toBe(true);
  });
});

describe('고정 LBC chart·CRD와 Helm 권한 경계', () => {
  test('공식 3.6.0 archive와 그 안의 CRD 원본 checksum을 고정한다', () => {
    const expected = {
      'vendor/aws-load-balancer-controller-3.6.0.tgz': 'ee0403fcd713d6f1d28b1ff17d0d6d47e011cc4dd727a0aed0d95ae46897226a',
      'crds/crds.yaml': 'a4fcee6ec3fefe69be490b53b6a244b93bbdb1c927f4782dff2b59316581bb7f',
      'crds/gateway-crds.yaml': '3a4264e2a7cf132944fd095b04ce86299385f26ea31b1e89d0ac21761e1865a0',
    };
    for (const [file, checksum] of Object.entries(expected)) {
      expect(createHash('sha256').update(fs.readFileSync(path.join(lbcPath, file))).digest('hex')).toBe(checksum);
    }
    const source = JSON.parse(fs.readFileSync(path.join(lbcPath, 'SOURCE.json'), 'utf8'));
    expect(source.chart).toMatchObject({ version: '3.6.0', appVersion: 'v3.6.0', sha256: expected['vendor/aws-load-balancer-controller-3.6.0.tgz'] });
    expect(source.controller.commit).toBe('267b5458b4c4c3066d47673a36dda275af07a6d6');
  });

  test('TGB는 OSS API 그룹이며 kubeconform schema가 고정 CRD의 v1beta1 schema와 같다', () => {
    const crds = loadAll(fs.readFileSync(path.join(lbcPath, 'crds/crds.yaml'), 'utf8')) as any[];
    const tgb = crds.find(crd => crd.metadata.name === 'targetgroupbindings.elbv2.k8s.aws');
    expect(tgb.spec.group).toBe('elbv2.k8s.aws');
    const schema = tgb.spec.versions.find((version: any) => version.name === 'v1beta1').schema.openAPIV3Schema;
    expect(schema.properties.spec.properties.controllerClass).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(lbcPath, 'schemas/targetgroupbinding_elbv2.k8s.aws_v1beta1.json'), 'utf8'))).toEqual(schema);
  });

  test('IMDS를 대체하는 runtime 입력·ServiceAccount·앱 노드 배치를 명시하고 다른 controller를 끈다', () => {
    const values = load(fs.readFileSync(path.join(lbcPath, 'values.yaml'), 'utf8')) as any;
    expect([values.clusterName, values.region, values.vpcId]).toEqual(['', '', '']);
    expect(values.image.tag).toBe('v3.6.0');
    expect(values.serviceAccount).toMatchObject({ create: true, name: 'aws-load-balancer-controller', annotations: {} });
    expect(values.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64', 'karpenter.sh/nodepool': 'pulsemetry-dev-apps' });
    expect(values.tolerations).toEqual([]);
    expect(values.watchNamespace).toBe('pulsemetry-dev');
    expect(values.enableBackendSecurityGroup).toBe(false);
    expect(values.enableManageBackendSecurityGroupRules).toBe(false);
    expect(values.enableServiceMutatorWebhook).toBe(false);
    expect(values.createIngressClassResource).toBe(false);
    expect(values.ingressClassParams.create).toBe(false);
    expect(values.disableIngressClassAnnotation).toBe(true);
    expect(values.enableWaf).toBe(false);
    expect(values.enableWafv2).toBe(false);
    expect(values.enableShield).toBe(false);
    expect(values.controllerConfig.featureGates).toMatchObject({
      EnableServiceController: false,
      NLBGatewayAPI: false,
      ALBGatewayAPI: false,
      NLBSecurityGroup: false,
      GlobalAcceleratorController: false,
    });
  });
});
