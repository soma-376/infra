import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildApp } from './helpers';

describe('DataStack', () => {
  const { data } = buildApp();
  const template = Template.fromStack(data);

  test('creates an Aurora PostgreSQL cluster named control with serverless v2 scaling', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      DatabaseName: 'control',
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 2,
      },
    });
  });

  test('cluster has DESTROY removal policy (DeletionPolicy Delete)', () => {
    template.hasResource('AWS::RDS::DBCluster', {
      DeletionPolicy: 'Delete',
    });
  });

  test('generates a DB credentials secret', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('raw signal bucket blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('raw signal bucket has a 30 day expiration lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' }),
        ]),
      },
    });
  });
});
