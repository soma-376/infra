import { buildDevApp } from '../helpers';

test('dev 최종 assembly는 EKS 전용 네 스택과 하나의 진입점만 가진다', () => {
  const assembly = buildDevApp({ devAllowedCidr: '203.0.113.10/32' }).app.synth();
  expect(assembly.stacks.map(stack => stack.stackName).sort()).toEqual([
    'DevDataStack', 'DevEdgeStack', 'DevEksStack', 'DevNetworkStack',
  ]);
  const resources = assembly.stacks.flatMap(stack => Object.values(stack.template.Resources)) as { Type: string }[];
  const count = (type: string) => resources.filter(resource => resource.Type === type).length;
  expect(resources.filter(resource => /^AWS::(ECS|AutoScaling|ServiceDiscovery)::/.test(resource.Type))).toEqual([]);
  expect(count('AWS::ElasticLoadBalancingV2::LoadBalancer')).toBe(1);
  expect(count('AWS::ElasticLoadBalancingV2::TargetGroup')).toBe(4);
  expect(count('AWS::WAFv2::WebACL')).toBe(1);
  expect(count('AWS::WAFv2::WebACLAssociation')).toBe(1);
  expect(count('AWS::EC2::SecurityGroup')).toBe(9);
  expect(count('AWS::EC2::Instance')).toBe(2);
  expect(count('AWS::EKS::Cluster')).toBe(1);
  expect(count('AWS::RDS::DBInstance')).toBe(1);
  expect(count('AWS::S3::Bucket')).toBe(2);
  expect(count('AWS::SecretsManager::Secret')).toBe(14);
});
