import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib/core';
import { BlockPublicAccess, Bucket, BucketEncryption, IBucket, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PERF_ENVIRONMENT_EVIDENCE_PREFIX, PERF_EVIDENCE_PREFIX, PERF_EVIDENCE_TAG } from './config';

export interface PerfEvidenceStackProps extends StackProps {
  readonly retentionDays: number;
}

/**
 * 시험 증거 bucket. 환경 스택과 수명을 분리해 환경을 지워도 남긴다(PLAN §10).
 *
 * 덮어쓰기는 쓰기 쪽 조건부 PUT(`If-None-Match: *`)이 막고, versioning이 실수로 덮인 이전 버전을 보존한다.
 * 이 bucket만 `RETAIN`이다. 다른 perf 자원은 환경과 함께 지운다.
 */
export class PerfEvidenceStack extends Stack {
  public readonly bucket: IBucket;

  constructor(scope: Construct, id: string, props: PerfEvidenceStackProps) {
    super(scope, id, props);
    const bucket = new Bucket(this, 'EvidenceBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [PERF_EVIDENCE_PREFIX, PERF_ENVIRONMENT_EVIDENCE_PREFIX].map(prefix => ({
        id: `expire-${prefix.replace(/\/$/, '')}`,
        prefix,
        expiration: Duration.days(props.retentionDays),
        noncurrentVersionExpiration: Duration.days(props.retentionDays),
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      })),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Tags.of(bucket).add(PERF_EVIDENCE_TAG, 'shared');
    this.bucket = bucket;
    for (const [name, value] of Object.entries({
      EvidenceBucketName: bucket.bucketName,
      EvidenceBucketArn: bucket.bucketArn,
      EvidencePrefix: PERF_EVIDENCE_PREFIX,
      EvidenceRetentionDays: String(props.retentionDays),
    })) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}
