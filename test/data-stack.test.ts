import { Template, Match } from 'aws-cdk-lib/assertions';
import { CONTROL_DB_NAME } from '../lib/config';
import { buildApp } from './helpers';

describe('DataStack', () => {
  const { data } = buildApp();
  const template = Template.fromStack(data);

  test('creates an Aurora PostgreSQL cluster named controlplane with serverless v2 scaling', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: '16.13',
      DatabaseName: CONTROL_DB_NAME,
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
