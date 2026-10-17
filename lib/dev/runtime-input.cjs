// ECS JSON과 EKS 생성기 YAML이 공유하는 비밀 없는 배포 입력 검사다.
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

function parseRuntimeInputs(input, { requireWriterImage = false } = {}) {
  const value = object(input, requireWriterImage ? ['writerImage', 'userAuth', 'dashboard'] : ['userAuth', 'dashboard'], 'root');
  if (requireWriterImage && !/^[0-9]{12}\.dkr\.ecr\.ap-northeast-2\.amazonaws\.com\/soma-376\/jwt-key-writer@sha256:[a-f0-9]{64}$/.test(value.writerImage ?? '')) fail('writerImage');
  const auth = object(value.userAuth, ['privateVersionId', 'publicVersionId', 'activeKid', 'publicKeys', 'issuer', 'audience', 'allowedOrigins'], 'userAuth');
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
  if (!Array.isArray(auth.publicKeys) || !auth.publicKeys.length || auth.publicKeys.length > 32) fail('userAuth.publicKeys');
  const kids = new Set(), aliases = new Set();
  for (const entry of auth.publicKeys) {
    object(entry, ['kid', 'alias'], 'publicKeys');
    const kid = text(entry.kid, 'publicKeys.kid');
    // Spring의 bracket map 표기를 보존할 수 없는 kid는 배포 전에 거부한다.
    if (kid.length > 128 || /[\[\]]/.test(kid) || kids.has(kid)) fail('publicKeys.kid');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.pem$/.test(entry.alias ?? '') || entry.alias === 'private.pem' || aliases.has(entry.alias)) fail('publicKeys.alias');
    kids.add(kid); aliases.add(entry.alias);
  }
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
  return JSON.parse(JSON.stringify(value));
}

module.exports = { parseRuntimeInputs };
