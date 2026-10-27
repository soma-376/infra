const { readFileSync } = require('node:fs');
const { isIPv4 } = require('node:net');
const { dirname, resolve } = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { load, JSON_SCHEMA } = require('js-yaml');

const REGION = 'ap-northeast-2';
const CERTIFICATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOGICAL_ID = /^[A-Za-z][A-Za-z0-9]{0,254}$/;
const CONTEXT_KEYS = ['devOidcClientKeys', 'devAllowedCidr', 'devHttpRedirectEnabled', 'devEksArchivePrefix', 'devEksOtlpTarget'];

function fail(field) {
  // 잘못 전달한 원문에 비밀이 있어도 오류에 포함하지 않는다.
  throw new Error(`devDeploymentProfile의 ${field} 입력이 올바르지 않습니다`);
}

function object(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) fail(field);
  return value;
}

function origin(value, field) {
  let url;
  try { url = new URL(value); } catch { fail(field); }
  if (typeof value !== 'string' || !/^https:\/\/[a-zA-Z0-9.-]+$/.test(value) ||
      url.origin !== value || url.port) fail(field);
  return value;
}

function json(value, field) {
  if (typeof value !== 'string') return value;
  try {
    const result = JSON.parse(value);
    load(value, { schema: JSON_SCHEMA }); // JSON.parse가 허용하는 중복 key도 거부한다.
    return result;
  } catch { fail(field); }
}

function stringList(value, field, pattern, max = Infinity) {
  const list = json(value, field);
  if (!Array.isArray(list) || list.length > max ||
      list.some(item => typeof item !== 'string' || !pattern.test(item)) ||
      new Set(list).size !== list.length) fail(field);
  return [...list].sort();
}

function normalizeContext(key, value) {
  if (key === 'devHttpRedirectEnabled') {
    if (![true, false, 'true', 'false'].includes(value)) fail(key);
    return value === true || value === 'true';
  }
  if (key === 'devOidcClientKeys') return stringList(value, key, /^[A-Za-z0-9_-]{1,64}$/, 32);
  if (key === 'devAllowedCidr') {
    if (typeof value !== 'string') fail(key);
    const cidrs = value.split(',').map(cidr => cidr.trim());
    if (!cidrs.length || cidrs.some(cidr => {
      const parts = cidr.split('/');
      return parts.length !== 2 || !isIPv4(parts[0]) || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1]);
    }) || new Set(cidrs).size !== cidrs.length) fail(key);
    return cidrs.sort().join(',');
  }
  if (key === 'devEksArchivePrefix') {
    if (!['eks_validation', 'eks'].includes(value)) fail(key);
    return value;
  }
  if (key === 'devEksOtlpTarget') {
    if (!['ingest', 'gateway'].includes(value)) fail(key);
    return value;
  }
  if (key === 'devEksAdditionalCertificateArns') {
    return stringList(value, key, /^arn:aws:acm:ap-northeast-2:\d{12}:certificate\/[0-9a-f-]{36}$/);
  }
  if (key === 'devEksAdditionalCertificateLogicalIds') {
    const mapping = json(value, key);
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
        Object.values(mapping).some(id => typeof id !== 'string' || !LOGICAL_ID.test(id))) fail(key);
    return Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right)));
  }
  return value;
}

/** 계정·ARN·Secret 원문 없이 추적하는 dev 배포 원본을 읽는다. (ADR-0040) */
function readDeploymentProfile(path) {
  if (typeof path !== 'string' || !path || path !== path.trim()) fail('경로');
  let profile;
  try { profile = json(readFileSync(resolve(path), 'utf8'), 'JSON'); }
  catch { fail('JSON 파일'); }
  object(profile, ['publicBaseUrl', 'frontendOrigin', 'runtimeValuesFile', 'certificates', 'context'], 'root');
  origin(profile.publicBaseUrl, 'publicBaseUrl');
  origin(profile.frontendOrigin, 'frontendOrigin');
  // 상대 경로는 같은 profile 디렉터리의 파일만 가리킨다. 개인 실행 경로를 원본에 넣지 않는다.
  if (typeof profile.runtimeValuesFile !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:yaml|yml|json)$/.test(profile.runtimeValuesFile)) fail('runtimeValuesFile');
  const certs = object(profile.certificates, ['defaultId', 'additional'], 'certificates');
  if (typeof certs.defaultId !== 'string' || !CERTIFICATE_ID.test(certs.defaultId) ||
      !Array.isArray(certs.additional)) fail('certificates');
  const ids = new Set([certs.defaultId]), logicalIds = new Set();
  for (const cert of certs.additional) {
    object(cert, ['id', 'logicalId'], 'certificates.additional');
    if (typeof cert.id !== 'string' || !CERTIFICATE_ID.test(cert.id) || ids.has(cert.id)) fail('certificates.additional.id');
    ids.add(cert.id);
    if (cert.logicalId !== undefined) {
      if (typeof cert.logicalId !== 'string' || !LOGICAL_ID.test(cert.logicalId) || logicalIds.has(cert.logicalId)) {
        fail('certificates.additional.logicalId');
      }
      logicalIds.add(cert.logicalId);
    }
  }
  object(profile.context, CONTEXT_KEYS, 'context');
  const context = Object.fromEntries(CONTEXT_KEYS.map(key => [key, normalizeContext(key, profile.context[key])]));
  return {
    ...profile,
    certificates: { defaultId: certs.defaultId, additional: [...certs.additional].sort((left, right) => left.id.localeCompare(right.id)) },
    context,
    runtimeValuesPath: resolve(dirname(resolve(path)), profile.runtimeValuesFile),
  };
}

/** 인증서의 계정은 실행 시 CDK_DEFAULT_ACCOUNT에서만 주입한다. */
function createProfileContext(profile, account) {
  if (typeof account !== 'string' || !/^\d{12}$/.test(account)) fail('CDK_DEFAULT_ACCOUNT');
  const arn = id => `arn:aws:acm:${REGION}:${account}:certificate/${id}`;
  const logicalIds = Object.fromEntries(profile.certificates.additional
    .filter(cert => cert.logicalId !== undefined).map(cert => [arn(cert.id), cert.logicalId]));
  return {
    ...profile.context,
    devEksPublicBaseUrl: profile.publicBaseUrl,
    devEksCertificateArn: arn(profile.certificates.defaultId),
    devEksAdditionalCertificateArns: profile.certificates.additional.map(cert => arn(cert.id)),
    ...(Object.keys(logicalIds).length ? { devEksAdditionalCertificateLogicalIds: logicalIds } : {}),
  };
}

/** 명시 context와 충돌하면 일부만 적용하지 않고, 리소스를 만들기 전에 모두 거부한다. */
function applyProfileContext(app, profile, account) {
  const context = createProfileContext(profile, account);
  for (const [key, value] of Object.entries(context)) {
    const existing = app.node.tryGetContext(key);
    if (existing !== undefined && !isDeepStrictEqual(normalizeContext(key, existing), value)) {
      throw new Error(`devDeploymentProfile과 명시한 ${key} context가 충돌합니다`);
    }
  }
  // 맵 없는 profile에 외부 맵을 섞어 다른 인증서 연결 ID를 가져오지 않는다.
  if (!Object.hasOwn(context, 'devEksAdditionalCertificateLogicalIds') &&
      app.node.tryGetContext('devEksAdditionalCertificateLogicalIds') !== undefined) {
    throw new Error('devDeploymentProfile과 명시한 devEksAdditionalCertificateLogicalIds context가 충돌합니다');
  }
  for (const [key, value] of Object.entries(context)) app.node.setContext(key, value);
  return context;
}

module.exports = { readDeploymentProfile, createProfileContext, applyProfileContext };
