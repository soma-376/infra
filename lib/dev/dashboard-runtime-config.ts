import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib/core';

export interface UserAuthRuntime {
  readonly privateVersionId: string;
  readonly publicVersionId: string;
  readonly activeKid: string;
  readonly publicKeys: readonly { readonly kid: string; readonly alias: string }[];
  readonly issuer: string;
  readonly audience: string;
  readonly allowedOrigins: readonly string[];
}

export interface DashboardRuntimeConfig {
  readonly writerImage: string;
  readonly userAuth: UserAuthRuntime;
  readonly dashboard: {
    readonly settings: Readonly<Record<string, string>>;
    readonly managementEnabled: boolean;
    readonly mailEnabled: boolean;
  };
}

const { parseRuntimeInputs } = require('./runtime-input.cjs') as {
  parseRuntimeInputs(value: unknown, options: { requireWriterImage: boolean }): DashboardRuntimeConfig;
};

export function parseDashboardRuntimeConfig(value: unknown): DashboardRuntimeConfig {
  return parseRuntimeInputs(value, { requireWriterImage: true });
}

/** 잘못된 입력을 기존 세 서비스 구성으로 조용히 되돌리지 않는다. */
export function loadDashboardRuntimeConfig(app: App): DashboardRuntimeConfig {
  const filename = app.node.tryGetContext('devDashboardRuntimeFile');
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('devDashboardRuntimeFile에 비밀 원문 없는 JSON 파일 경로가 필요하다');
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('devDashboardRuntimeFile 파일을 읽거나 JSON으로 해석할 수 없다'); }
  return parseDashboardRuntimeConfig(value);
}

export const JWT_KEY_DIRECTORY = '/mnt/user-jwt/keys';

/** Spring Map의 대소문자·점·슬래시를 bracket notation으로 보존한다. */
export function userAuthEnvironment(config: DashboardRuntimeConfig, signer: boolean): Record<string, string> {
  const auth = config.userAuth;
  const environment: Record<string, string> = {
    PULSEMETRY_USER_AUTH_ENABLED: 'true',
    PULSEMETRY_USER_AUTH_ISSUER: auth.issuer,
    PULSEMETRY_USER_AUTH_AUDIENCE: auth.audience,
    PULSEMETRY_USER_AUTH_ALLOWED_ORIGINS: auth.allowedOrigins.join(','),
    PULSEMETRY_MANAGEMENT_ENABLED: String(config.dashboard.managementEnabled),
    PULSEMETRY_MAIL_ENABLED: String(config.dashboard.mailEnabled),
    SPRING_APPLICATION_JSON: JSON.stringify({ pulsemetry: { 'user-auth': { 'public-key-files': Object.fromEntries(
      auth.publicKeys.map(({ kid, alias }) => [`[${kid}]`, `${JWT_KEY_DIRECTORY}/${alias}`]),
    ) } } }),
  };
  if (signer) {
    environment.PULSEMETRY_USER_AUTH_ACTIVE_KID = auth.activeKid;
    environment.PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE = `${JWT_KEY_DIRECTORY}/private.pem`;
  }
  return environment;
}
