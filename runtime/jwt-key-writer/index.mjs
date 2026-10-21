import { createPrivateKey, createPublicKey, randomBytes, sign, verify, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROOT_DIRECTORY = '/mnt/user-jwt';
export const DEADLINE_MS = 30_000;
const MAX_SECRET_BYTES = 65_536;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.pem$/;
const VERSION = /^[A-Za-z0-9-]{32,64}$/;
const ARN = /^arn:aws:secretsmanager:([a-z0-9-]+):\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/;
const ERROR_CODES = new Set([
  'CONFIG_INVALID', 'SECRET_FETCH_FAILED', 'SECRET_RESPONSE_INVALID', 'KEYRING_INVALID',
  'PEM_INVALID', 'KEY_PAIR_MISMATCH', 'PATH_UNSAFE', 'FILESYSTEM_FAILED',
  'FILE_ACCESS_FAILED', 'DEADLINE_EXCEEDED', 'WRITER_FAILED',
]);

/** 값·SDK 예외·경로를 보관하지 않고 고정 코드만 외부로 전달한다. */
export class WriterError extends Error {
  constructor(code) {
    super(ERROR_CODES.has(code) ? code : 'WRITER_FAILED');
    this.name = 'WriterError';
    this.code = this.message;
  }
}

export function safeErrorCode(error) {
  return error instanceof WriterError && ERROR_CODES.has(error.code) ? error.code : 'WRITER_FAILED';
}

function fail(code) { throw new WriterError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** 배포 입력은 비밀이 아닌 참조만 받으며 추가 필드와 불완전한 signer 설정은 거부한다. */
export function validateConfig(raw) {
  const fields = new Set(['region', 'publicSecretArn', 'publicVersionId', 'publicKeys', 'privateSecretArn', 'privateVersionId', 'activeKid']);
  if (!object(raw) || Object.keys(raw).some((key) => !fields.has(key))) fail('CONFIG_INVALID');
  if (raw.region !== 'ap-northeast-2' || typeof raw.publicSecretArn !== 'string' ||
      ARN.exec(raw.publicSecretArn)?.[1] !== raw.region || typeof raw.publicVersionId !== 'string' || !VERSION.test(raw.publicVersionId) ||
      !Array.isArray(raw.publicKeys) || raw.publicKeys.length === 0) fail('CONFIG_INVALID');
  const kids = new Set();
  const aliases = new Set();
  const publicKeys = raw.publicKeys.map((entry) => {
    if (!object(entry) || Object.keys(entry).sort().join(',') !== 'alias,kid' ||
        typeof entry.kid !== 'string' || !entry.kid.trim() || /[\u0000-\u001f\u007f]/.test(entry.kid) ||
        typeof entry.alias !== 'string' || !ALIAS.test(entry.alias) || entry.alias === 'private.pem' ||
        kids.has(entry.kid) || aliases.has(entry.alias)) fail('CONFIG_INVALID');
    kids.add(entry.kid);
    aliases.add(entry.alias);
    return Object.freeze({ kid: entry.kid, alias: entry.alias });
  });
  const signer = ['privateSecretArn', 'privateVersionId', 'activeKid'].filter((key) => Object.hasOwn(raw, key));
  if (signer.length !== 0 && signer.length !== 3) fail('CONFIG_INVALID');
  if (signer.length && (typeof raw.privateSecretArn !== 'string' ||
      ARN.exec(raw.privateSecretArn)?.[1] !== raw.region || raw.privateSecretArn === raw.publicSecretArn ||
      typeof raw.privateVersionId !== 'string' || !VERSION.test(raw.privateVersionId) || !kids.has(raw.activeKid))) fail('CONFIG_INVALID');
  return Object.freeze({ ...raw, publicKeys: Object.freeze(publicKeys) });
}

/** 공개키링은 문자열 쌍만 허용하며 JSON.parse가 덮어쓰는 중복 kid도 거부한다. */
function parseKeyring(source) {
  const result = new Map();
  let offset = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(source[offset] ?? '\0')) offset++; };
  const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const string = () => {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) fail('KEYRING_INVALID');
    offset = token.lastIndex;
    return JSON.parse(match[0]);
  };
  whitespace();
  if (source[offset++] !== '{') fail('KEYRING_INVALID');
  whitespace();
  if (source[offset] === '}') fail('KEYRING_INVALID');
  while (true) {
    const kid = string();
    whitespace();
    if (source[offset++] !== ':') fail('KEYRING_INVALID');
    whitespace();
    const pem = string();
    if (result.has(kid)) fail('KEYRING_INVALID');
    result.set(kid, pem);
    whitespace();
    const separator = source[offset++];
    whitespace();
    if (separator === '}') break;
    if (separator !== ',') fail('KEYRING_INVALID');
  }
  if (offset !== source.length) fail('KEYRING_INVALID');
  return result;
}

function parsePem(pem, kind) {
  const label = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
  if (typeof pem !== 'string' || !new RegExp(`^-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+\\r?\\n-----END ${label}-----\\s*$`).test(pem)) fail('PEM_INVALID');
  try {
    const key = kind === 'private'
      ? createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' })
      : createPublicKey({ key: pem, format: 'pem', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail('PEM_INVALID');
    return key;
  } catch { fail('PEM_INVALID'); }
}

function safeRoot(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/') fail('PATH_UNSAFE');
  const parts = root.split(path.sep).filter(Boolean);
  let current = path.parse(root).root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let entry;
    try { entry = fs.lstatSync(current); }
    catch (error) {
      if (error?.code !== 'ENOENT' || index !== parts.length - 1) fail('PATH_UNSAFE');
      fs.mkdirSync(current, { mode: 0o755 });
      entry = fs.lstatSync(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('PATH_UNSAFE');
    if (index === parts.length - 1 && (entry.uid !== process.getuid() || (entry.mode & 0o022))) fail('PATH_UNSAFE');
  }
  fs.chmodSync(root, 0o755);
  try { fs.lstatSync(path.join(root, 'keys')); fail('PATH_UNSAFE'); }
  catch (error) { if (error instanceof WriterError || error?.code !== 'ENOENT') throw error; }
}

const READ_PROBE = `const fs=require('node:fs');try{for(const p of process.argv.slice(1)){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||fs.readFileSync(p).length===0)process.exit(1)}}catch{process.exit(1)}`;

function checkAccess(files, identity, remainingMs) {
  const options = { timeout: Math.max(1, remainingMs), stdio: 'ignore', env: {} };
  if (identity.uid !== process.getuid() || identity.gid !== process.getgid()) {
    options.uid = identity.uid;
    options.gid = identity.gid;
  }
  const probe = spawnSync(process.execPath, ['-e', READ_PROBE, ...files], options);
  if (probe.error || probe.status !== 0) fail('FILE_ACCESS_FAILED');
}

/** 테스트는 fetchSecret과 임시 volume을 주입한다. CLI는 고정 runtime 설정만 사용한다. */
export async function runWriter(raw, options) {
  const config = validateConfig(raw);
  const { fetchSecret, rootDirectory = ROOT_DIRECTORY, deadlineMs = DEADLINE_MS,
    identity = { uid: 10001, gid: 10001 }, now = Date.now } = options ?? {};
  if (typeof fetchSecret !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 ||
      !Number.isInteger(identity.uid) || identity.uid < 0 || !Number.isInteger(identity.gid) || identity.gid < 0) fail('CONFIG_INVALID');
  const deadline = now() + deadlineMs;
  const abort = new AbortController();
  let timer;
  let stage;
  const checkDeadline = () => { if (abort.signal.aborted || now() >= deadline) fail('DEADLINE_EXCEEDED'); };
  const fetch = async (secretArn, versionId) => {
    let response;
    try { response = await fetchSecret({ SecretId: secretArn, VersionId: versionId }, { abortSignal: abort.signal }); }
    catch { checkDeadline(); fail('SECRET_FETCH_FAILED'); }
    checkDeadline();
    if (!object(response) || response.ARN !== secretArn || response.VersionId !== versionId ||
        typeof response.SecretString !== 'string' || !response.SecretString.length ||
        Buffer.byteLength(response.SecretString) > MAX_SECRET_BYTES || response.SecretBinary !== undefined) fail('SECRET_RESPONSE_INVALID');
    return response.SecretString;
  };
  try {
    const work = async () => {
      const [publicValue, privateValue] = await Promise.all([
        fetch(config.publicSecretArn, config.publicVersionId),
        config.privateSecretArn ? fetch(config.privateSecretArn, config.privateVersionId) : undefined,
      ]);
      checkDeadline();
      const ring = parseKeyring(publicValue);
      if (ring.size !== config.publicKeys.length || config.publicKeys.some(({ kid }) => !ring.has(kid))) fail('KEYRING_INVALID');
      const parsed = new Map(config.publicKeys.map(({ kid }) => [kid, parsePem(ring.get(kid), 'public')]));
      if (privateValue !== undefined) {
        const privateKey = parsePem(privateValue, 'private');
        const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
        const expected = parsed.get(config.activeKid).export({ format: 'der', type: 'spki' });
        if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) fail('KEY_PAIR_MISMATCH');
        const challenge = randomBytes(32);
        if (!verify('RSA-SHA256', challenge, parsed.get(config.activeKid), sign('RSA-SHA256', challenge, privateKey))) fail('KEY_PAIR_MISMATCH');
      }
      checkDeadline();
      safeRoot(rootDirectory);
      stage = fs.mkdtempSync(path.join(rootDirectory, '.staging-'));
      fs.chmodSync(stage, 0o700);
      const contents = config.publicKeys.map(({ kid, alias }) => [alias, ring.get(kid)]);
      if (privateValue !== undefined) contents.push(['private.pem', privateValue]);
      const files = [];
      for (const [alias, pem] of contents) {
        checkDeadline();
        const filename = path.join(stage, alias);
        const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          fs.writeFileSync(descriptor, pem);
          fs.fchownSync(descriptor, identity.uid, identity.gid);
          fs.fchmodSync(descriptor, 0o440);
          fs.fsyncSync(descriptor);
        } finally { fs.closeSync(descriptor); }
        files.push(filename);
      }
      fs.chownSync(stage, identity.uid, identity.gid);
      fs.chmodSync(stage, 0o750);
      checkAccess(files, identity, deadline - now());
      checkDeadline();
      fs.renameSync(stage, path.join(rootDirectory, 'keys'));
      stage = undefined;
    };
    await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new WriterError('DEADLINE_EXCEEDED')); }, deadlineMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof WriterError) throw error;
    fail('FILESYSTEM_FAILED');
  } finally {
    clearTimeout(timer);
    abort.abort();
    if (stage !== undefined) {
      try { fs.rmSync(stage, { recursive: true, force: true }); }
      catch { fail('FILESYSTEM_FAILED'); }
    }
  }
}
