// EKS 생성기 YAML의 비밀 없는 앱 배포 입력 검사다.
const DURATION_SETTINGS = {
  RETRY_AFTER: 1, CLICKHOUSE_SOURCE_QUERY_TIMEOUT: 1, CLICKHOUSE_CACHE_QUERY_TIMEOUT: 1,
  SNAPSHOT_BUILD_TIMEOUT: 1, SNAPSHOT_PURGE_GRACE: 0, SNAPSHOT_CLEANUP_INTERVAL: 1,
  INGEST_WINDOW: 60, INGEST_DELAYED_AFTER: 0.001, INGEST_DOWN_AFTER: 0.001,
  COMPLETENESS_SETTLE_AFTER: 0.001, SEATS_STALE_AFTER: 0.001,
  ALERTS_EVALUATION_INTERVAL: 0.001, ALERTS_LEASE: 0.001,
};
const INTEGER_SETTINGS = [
  'CLICKHOUSE_SOURCE_MAX_RESULT_ROWS', 'CLICKHOUSE_SOURCE_MAX_RESULT_BYTES',
  'SNAPSHOT_MAX_CONCURRENT_BUILDS', 'SNAPSHOT_MAX_COPY_ROWS', 'SNAPSHOT_MAX_COPY_BYTES',
];
const PREFIX = 'PULSEMETRY_DASHBOARD_';

function fail(field) { throw new Error(`dashboard runtime 입력 오류: ${field}`); }
function object(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(field);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${field} 허용하지 않는 필드`);
  return value;
}
function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail(field);
  return value;
}
function duration(value, minimum, field) {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text(value, field));
  if (!match) fail(field);
  const milliseconds = Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (!Number.isSafeInteger(milliseconds) || milliseconds < minimum * 1000) fail(field);
  return milliseconds / 1000;
}

function httpUrl(value, field, base = false) {
  text(value, field);
  // dev 입력은 HTTP도 받되 URI 구조를 검사한다. URL 파서가 지워 버리는 빈 ?/#,
  // 공백·backslash 및 잘못된 percent escape도 입력 단계에서 거부한다.
  const scheme = /^https?:\/\//.exec(value)?.[0];
  if (!scheme || /[^\x21-\x7e]|[?#,\\<>"{}|^`]/.test(value) ||
      /%(?![0-9a-fA-F]{2})/.test(value)) fail(field);
  let url; try { url = new URL(value); } catch { fail(field); }
  const authority = value.slice(scheme.length).split('/')[0];
  const pathname = value.slice(scheme.length + authority.length);
  // Java URI.host가 거부하는 빈 DNS label·label 양끝 하이픈을 배포 전에 차단한다.
  const validHost = url.hostname.startsWith('[') || /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/.test(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || authority.includes('@') || authority.includes('%') ||
      !validHost || /[\[\]]/.test(pathname) ||
      (base && !['', '/'].includes(pathname)) || (!base && value.length > 256)) fail(field);
  return value;
}

// 맵 key를 환경변수 이름으로 변형하지 않는다. 대소문자·하이픈·underscore 충돌을 피한다.
function oidcClientBindings(oidc) {
  return [...(oidc?.clients ?? [])].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map((client, index) => ({ ...client, alias: `PULSEMETRY_OIDC_CLIENT_SECRET_${index}` }));
}

function parseOidc(input, redirectUris) {
  const oidc = object(input, ['enabled', 'clients', 'callbackBaseUrl', 'callbackRegistrationId', 'failureRedirectUri', 'allowInsecureLocalhost'], 'oidc');
  if (typeof oidc.enabled !== 'boolean') fail('oidc.enabled');
  if (oidc.allowInsecureLocalhost !== undefined && typeof oidc.allowInsecureLocalhost !== 'boolean') fail('oidc.allowInsecureLocalhost');
  const clients = oidc.clients ?? [];
  if (!Array.isArray(clients) || clients.length > 32 || (oidc.enabled && clients.length === 0)) fail('oidc.clients');
  const keys = new Set();
  for (const client of clients) {
    object(client, ['key', 'versionId'], 'oidc.clients');
    if (typeof client.key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(client.key) || keys.has(client.key)) fail('oidc.clients.key');
    keys.add(client.key);
    if (oidc.enabled || client.versionId !== undefined) {
      if (typeof client.versionId !== 'string' || !/^[A-Za-z0-9-]{32,64}$/.test(client.versionId)) fail('oidc.clients.versionId');
    }
  }
  const registrationId = oidc.callbackRegistrationId ?? 'oidc';
  if (typeof registrationId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(registrationId)) fail('oidc.callbackRegistrationId');
  if (oidc.enabled || oidc.callbackBaseUrl !== undefined) httpUrl(oidc.callbackBaseUrl, 'oidc.callbackBaseUrl', true);
  if (oidc.failureRedirectUri !== undefined) {
    httpUrl(oidc.failureRedirectUri, 'oidc.failureRedirectUri');
    if (!redirectUris?.includes(oidc.failureRedirectUri)) fail('oidc.failureRedirectUri 허용 목록 불일치');
  }
  if (oidc.enabled && !redirectUris?.length) fail('userAuth.allowedRedirectUris');
  return { ...oidc, allowInsecureLocalhost: oidc.allowInsecureLocalhost ?? false, callbackRegistrationId: registrationId,
    clients: oidcClientBindings({ clients }).map(({ alias, ...client }) => client) };
}

// kid는 Spring bracket map key, alias는 mount 안의 파일 이름이다. 경로·개인키 파일과 충돌하지 않게 한다.
function parsePublicKeys(list, field, itemField) {
  if (!Array.isArray(list) || !list.length || list.length > 32) fail(field);
  const kids = new Set(), aliases = new Set();
  for (const entry of list) {
    object(entry, ['kid', 'alias'], itemField);
    const kid = text(entry.kid, `${itemField}.kid`);
    // Spring의 bracket map 표기를 보존할 수 없는 kid는 배포 전에 거부한다.
    if (kid.length > 128 || /[\[\]]/.test(kid) || kids.has(kid)) fail(`${itemField}.kid`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.pem$/.test(entry.alias ?? '') || entry.alias === 'private.pem' || aliases.has(entry.alias)) fail(`${itemField}.alias`);
    kids.add(kid); aliases.add(entry.alias);
  }
  return kids;
}

// telemetry JWT는 EKS runtime 입력이다. dev ECS 입력은 폐기됐다. (ADR-0036)
function parseTelemetryJwt(input) {
  const telemetry = object(input, ['privateVersionId', 'publicVersionId', 'activeKid', 'publicKeys', 'issueEnabled'], 'telemetryJwt');
  for (const field of ['privateVersionId', 'publicVersionId']) {
    if (!/^[A-Za-z0-9-]{32,64}$/.test(telemetry[field] ?? '')) fail(`telemetryJwt.${field}`);
  }
  const kids = parsePublicKeys(telemetry.publicKeys, 'telemetryJwt.publicKeys', 'telemetryJwt.publicKeys');
  if (!kids.has(text(telemetry.activeKid, 'telemetryJwt.activeKid'))) fail('telemetryJwt.activeKid');
  if (typeof telemetry.issueEnabled !== 'boolean') fail('telemetryJwt.issueEnabled');
}

function parseRuntimeInputs(input, { eks = true } = {}) {
  const keys = ['userAuth', 'dashboard', 'oidc'];
  const value = object(input, eks ? [...keys, 'telemetryJwt', 'ingestMode', 'jvmGcSafepointLog'] : keys, 'root');
  if (eks) {
    parseTelemetryJwt(value.telemetryJwt);
    if (!['http', 'dual', 'kafka'].includes(value.ingestMode)) fail('ingestMode');
    // 성능 비교 구간에서만 켜는 Gateway·ingest GC/safepoint stderr 로그다. 생략하면 끈다. (ADR-0037)
    if (value.jvmGcSafepointLog !== undefined && typeof value.jvmGcSafepointLog !== 'boolean') fail('jvmGcSafepointLog');
  }
  const auth = object(value.userAuth, ['privateVersionId', 'publicVersionId', 'activeKid', 'publicKeys', 'issuer', 'audience', 'allowedOrigins', 'allowedRedirectUris'], 'userAuth');
  for (const field of ['privateVersionId', 'publicVersionId']) {
    if (!/^[A-Za-z0-9-]{32,64}$/.test(auth[field] ?? '')) fail(`userAuth.${field}`);
  }
  for (const field of ['activeKid', 'issuer', 'audience']) text(auth[field], `userAuth.${field}`);
  if (!Array.isArray(auth.allowedOrigins) || auth.allowedOrigins.length === 0) fail('userAuth.allowedOrigins');
  for (const origin of auth.allowedOrigins) {
    text(origin, 'userAuth.allowedOrigins');
    let url; try { url = new URL(origin); } catch { fail('userAuth.allowedOrigins'); }
    if (origin.includes(',') || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) fail('userAuth.allowedOrigins');
  }
  if (new Set(auth.allowedOrigins).size !== auth.allowedOrigins.length) fail('userAuth.allowedOrigins 중복');
  if (auth.allowedRedirectUris !== undefined) {
    if (!Array.isArray(auth.allowedRedirectUris) || new Set(auth.allowedRedirectUris).size !== auth.allowedRedirectUris.length) fail('userAuth.allowedRedirectUris');
    for (const uri of auth.allowedRedirectUris) httpUrl(uri, 'userAuth.allowedRedirectUris');
  }
  const oidc = value.oidc === undefined ? undefined : parseOidc(value.oidc, auth.allowedRedirectUris);
  const kids = parsePublicKeys(auth.publicKeys, 'userAuth.publicKeys', 'publicKeys');
  if (!kids.has(auth.activeKid)) fail('userAuth.activeKid');
  const dashboard = object(value.dashboard, ['settings', 'managementEnabled', 'mailEnabled'], 'dashboard');
  for (const key of ['managementEnabled', 'mailEnabled']) if (typeof dashboard[key] !== 'boolean') fail(`dashboard.${key}`);
  // 관리 응답/메일 암호화키 공급은 이 릴리스 범위 밖이다. 불완전한 활성화를 막는다.
  if (dashboard.managementEnabled || dashboard.mailEnabled) fail('managementEnabled/mailEnabled 추가 Secret 공급 미구현');
  const allowed = [...Object.keys(DURATION_SETTINGS), ...INTEGER_SETTINGS, 'MEMBERS_IDLE_DAYS'].map(key => PREFIX + key);
  const settings = object(dashboard.settings, allowed, 'dashboard.settings');
  const seconds = {};
  for (const [key, minimum] of Object.entries(DURATION_SETTINGS)) seconds[key] = duration(settings[PREFIX + key], minimum, PREFIX + key);
  if (seconds.INGEST_WINDOW % 60 !== 0 || seconds.INGEST_DOWN_AFTER <= seconds.INGEST_DELAYED_AFTER) fail('dashboard.ingest 시간 관계');
  for (const key of INTEGER_SETTINGS) {
    const raw = settings[PREFIX + key];
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(PREFIX + key);
  }
  if (Number(settings[PREFIX + 'SNAPSHOT_MAX_CONCURRENT_BUILDS']) > 2147483647) fail('SNAPSHOT_MAX_CONCURRENT_BUILDS');
  if (!['7', '14', '30', '60'].includes(settings[PREFIX + 'MEMBERS_IDLE_DAYS'])) fail('MEMBERS_IDLE_DAYS');
  return JSON.parse(JSON.stringify({ ...value, ...(oidc ? { oidc } : {}) }));
}

module.exports = { parseRuntimeInputs, oidcClientBindings };
