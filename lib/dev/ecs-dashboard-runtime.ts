import { Duration, Stack } from 'aws-cdk-lib/core';
import { ContainerDefinition, ContainerDependencyCondition, ContainerImage, Ec2TaskDefinition, LogDriver, Secret as EcsSecret } from 'aws-cdk-lib/aws-ecs';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { CONTROL_DB_NAME, CONTROL_DB_SSLMODE, PORTS, buildJdbcUrl } from '../common/config';
import { DashboardRuntimeConfig, userAuthEnvironment } from './dashboard-runtime-config';

export interface DashboardDatabaseSecrets {
  readonly rdsSource: ISecret;
  readonly rdsCache: ISecret;
  readonly clickhouseSource: ISecret;
  readonly clickhouseCache: ISecret;
}

/** DB 자격 증명은 execution role, JWT SDK 권한은 task role에만 부여한다. */
export function dashboardEcsSettings(config: DashboardRuntimeConfig, dbEndpoint: string, clickhouseUrl: string, secrets: DashboardDatabaseSecrets) {
  const jdbc = buildJdbcUrl({ host: dbEndpoint, port: PORTS.aurora, dbname: CONTROL_DB_NAME, sslmode: CONTROL_DB_SSLMODE });
  const environment = {
    ...config.dashboard.settings,
    ...userAuthEnvironment(config, false),
    PULSEMETRY_DASHBOARD_PORT: '8081',
    PULSEMETRY_DASHBOARD_RDS_SOURCE_URL: jdbc,
    PULSEMETRY_DASHBOARD_RDS_CACHE_URL: jdbc,
    PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_URL: clickhouseUrl,
    PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_URL: clickhouseUrl,
    PULSEMETRY_DASHBOARD_CLICKHOUSE_SOURCE_DATABASE: 'default',
    PULSEMETRY_DASHBOARD_CLICKHOUSE_CACHE_DATABASE: 'dashboard_cache',
  };
  const injected: Record<string, EcsSecret> = {};
  for (const [key, secret] of Object.entries({ RDS_SOURCE: secrets.rdsSource, RDS_CACHE: secrets.rdsCache, CLICKHOUSE_SOURCE: secrets.clickhouseSource, CLICKHOUSE_CACHE: secrets.clickhouseCache })) {
    for (const field of ['username', 'password']) injected[`PULSEMETRY_DASHBOARD_${key}_${field.toUpperCase()}`] = EcsSecret.fromSecretsManager(secret, field);
  }
  return { environment, secrets: injected };
}

export function attachUserJwtKeyWriter(task: Ec2TaskDefinition, app: ContainerDefinition, config: DashboardRuntimeConfig, publicKey: ISecret, privateKey?: ISecret, logging?: LogDriver): ContainerDefinition {
  const { userAuth: auth } = config;
  const signer = privateKey !== undefined;
  const volumeName = 'user-jwt';
  task.addVolume({ name: volumeName });
  // 조회 권한은 같은 task의 앱과 writer가 공유한다. 이미지 pull은 execution role이다.
  task.addToTaskRolePolicy(new PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [publicKey.secretArn, ...(privateKey ? [privateKey.secretArn] : [])] }));
  const [repositoryUri, digest] = config.writerImage.split('@');
  const account = repositoryUri.split('.')[0];
  const repository = Repository.fromRepositoryAttributes(task, 'JwtWriterRepository', {
    repositoryName: 'soma-376/jwt-key-writer',
    repositoryArn: `arn:aws:ecr:ap-northeast-2:${account}:repository/soma-376/jwt-key-writer`,
  });
  const writer = task.addContainer('jwt-key-writer', {
    image: ContainerImage.fromEcrRepository(repository, digest),
    essential: false,
    startTimeout: Duration.seconds(60),
    logging,
    user: '0:0',
    readonlyRootFilesystem: true,
    memoryReservationMiB: 64,
    memoryLimitMiB: 128,
    environment: { JWT_WRITER_CONFIG: Stack.of(task).toJsonString({
      region: Stack.of(task).region, publicSecretArn: publicKey.secretArn,
      publicVersionId: auth.publicVersionId, publicKeys: auth.publicKeys,
      ...(privateKey ? { privateSecretArn: privateKey.secretArn, privateVersionId: auth.privateVersionId, activeKid: auth.activeKid } : {}),
    }) },
  });
  writer.addMountPoints({ sourceVolume: volumeName, containerPath: '/mnt/user-jwt', readOnly: false });
  app.addMountPoints({ sourceVolume: volumeName, containerPath: '/mnt/user-jwt', readOnly: true });
  app.addContainerDependencies({ container: writer, condition: ContainerDependencyCondition.SUCCESS });
  for (const [key, value] of Object.entries(userAuthEnvironment(config, signer))) app.addEnvironment(key, value);
  return writer;
}
