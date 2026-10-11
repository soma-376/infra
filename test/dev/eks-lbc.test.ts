import * as fs from 'fs';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DevEksLbc } from '../../lib/dev/eks-lbc';
import { TEST_ENV } from '../helpers';

const clusterName = 'soma-376-dev-eks';

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
