import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runWriter, validateConfig, safeErrorCode, WriterError } from '../index.mjs';

// 테스트에서만 만든 일회성 키다. AWS·배포 원본·저장소의 generated 디렉터리는 읽지 않는다.
function pair(bits = 2048, type = 'rsa') {
  return generateKeyPairSync(type, {
    ...(type === 'rsa' ? { modulusLength: bits } : { namedCurve: 'prime256v1' }),
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
}
const first = pair();
const second = pair();
const weak = pair(1024);
const ec = pair(0, 'ec');
const publicArn = 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:test/public-ABC123';
const privateArn = 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:test/private-DEF456';
const publicVersion = 'a'.repeat(32);
const privateVersion = 'b'.repeat(32);
const kid = 'Kid.2026/Blue';
const config = {
  region: 'ap-northeast-2', publicSecretArn: publicArn, publicVersionId: publicVersion,
  publicKeys: [{ kid, alias: 'public-0.pem' }],
};
const signer = { ...config, privateSecretArn: privateArn, privateVersionId: privateVersion, activeKid: kid };

function fixture(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jwt-writer-test-'));
  fs.chmodSync(base, 0o755);
  t.after(() => fs.rmSync(base, { force: true, recursive: true }));
  const rootDirectory = path.join(base, 'volume');
  const calls = [];
  const fetchSecret = async (input, options) => {
    calls.push({ input, signal: options.abortSignal });
    return {
      ARN: input.SecretId, VersionId: input.VersionId,
      SecretString: input.SecretId === privateArn ? first.privateKey : JSON.stringify({ [kid]: first.publicKey }),
    };
  };
  return {
    rootDirectory, calls, base,
    options: { rootDirectory, fetchSecret, identity: { uid: process.getuid(), gid: process.getgid() }, ...overrides },
  };
}

async function fails(t, input, code, overrides) {
  const f = fixture(t, overrides);
  await assert.rejects(runWriter(input, f.options), (error) => error instanceof WriterError && error.code === code && error.message === code);
  assert.equal(fs.existsSync(path.join(f.rootDirectory, 'keys')), false);
  if (fs.existsSync(f.rootDirectory)) assert.deepEqual(fs.readdirSync(f.rootDirectory), []);
  return f;
}

test('검증 전용은 공개키의 정확한 ARN·VersionId만 조회하고 0440 파일을 게시한다', async (t) => {
  const f = fixture(t);
  await runWriter(config, f.options);
  assert.deepEqual(f.calls.map(({ input }) => input), [{ SecretId: publicArn, VersionId: publicVersion }]);
  const directory = path.join(f.rootDirectory, 'keys');
  assert.deepEqual(fs.readdirSync(f.rootDirectory), ['keys']);
  assert.deepEqual(fs.readdirSync(directory), ['public-0.pem']);
  assert.equal(fs.readFileSync(path.join(directory, 'public-0.pem'), 'utf8') === first.publicKey, true);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o750);
  assert.equal(fs.statSync(path.join(directory, 'public-0.pem')).mode & 0o777, 0o440);
  assert.equal(fs.statSync(f.rootDirectory).mode & 0o777, 0o755);
});

test('signer는 독립 VersionId 두 개를 조회하고 키쌍 검증 후 개인키를 함께 게시한다', async (t) => {
  const f = fixture(t);
  await runWriter(signer, f.options);
  assert.deepEqual(f.calls.map(({ input }) => input), [
    { SecretId: publicArn, VersionId: publicVersion },
    { SecretId: privateArn, VersionId: privateVersion },
  ]);
  assert.deepEqual(fs.readdirSync(path.join(f.rootDirectory, 'keys')).sort(), ['private.pem', 'public-0.pem']);
  assert.equal(fs.readFileSync(path.join(f.rootDirectory, 'keys', 'private.pem'), 'utf8') === first.privateKey, true);
});

test('회전 중 두 kid의 대소문자·구두점을 보존하고 안전한 alias에 게시한다', async (t) => {
  const input = { ...config, publicKeys: [...config.publicKeys, { kid: 'old-KID', alias: 'public-1.pem' }] };
  const f = fixture(t, { fetchSecret: async (request) => ({ ARN: request.SecretId, VersionId: request.VersionId,
    SecretString: JSON.stringify({ [kid]: first.publicKey, 'old-KID': second.publicKey }) }) });
  await runWriter(input, f.options);
  assert.deepEqual(fs.readdirSync(path.join(f.rootDirectory, 'keys')).sort(), ['public-0.pem', 'public-1.pem']);
});

test('잘못된 입력·부분 signer·경로 이탈·중복 alias·예약 파일명을 조회 전에 거부한다', async (t) => {
  const invalid = [
    null, [], { ...config, extra: true }, { ...config, region: 'us-east-1' },
    { ...config, publicVersionId: 'AWSCURRENT' }, { ...config, publicVersionId: [publicVersion] },
    { ...config, publicSecretArn: 'not-an-arn' }, { ...config, publicKeys: [] },
    { ...config, privateSecretArn: privateArn }, { ...signer, activeKid: 'absent' },
    { ...signer, privateSecretArn: publicArn },
    ...['../bad.pem', '/bad.pem', '.hidden.pem', 'private.pem', 'key.txt', 'bad\\key.pem'].map((alias) => ({ ...config, publicKeys: [{ kid, alias }] })),
    { ...config, publicKeys: [config.publicKeys[0], { kid: 'another', alias: 'public-0.pem' }] },
    { ...config, publicKeys: [config.publicKeys[0], { kid, alias: 'other.pem' }] },
  ];
  for (const input of invalid) {
    const f = await fails(t, input, 'CONFIG_INVALID');
    assert.equal(f.calls.length, 0);
  }
});

test('추가·누락·중복 kid와 비문자열·손상 JSON을 거부한다', async (t) => {
  const rings = [
    '{}', '[]', 'null', JSON.stringify({ other: first.publicKey }),
    JSON.stringify({ [kid]: first.publicKey, extra: first.publicKey }),
    JSON.stringify({ [kid]: 42 }), '{"key":"pem",}',
    `{${JSON.stringify(kid)}:${JSON.stringify(first.publicKey)},${JSON.stringify(kid)}:${JSON.stringify(first.publicKey)}}`,
    `${JSON.stringify({ [kid]: first.publicKey })}garbage`,
  ];
  for (const SecretString of rings) await fails(t, config, 'KEYRING_INVALID', {
    fetchSecret: async (request) => ({ ARN: request.SecretId, VersionId: request.VersionId, SecretString }),
  });
});

test('빈 응답·binary·원본/버전 불일치·Secret 크기 초과를 거부한다', async (t) => {
  const valid = { ARN: publicArn, VersionId: publicVersion, SecretString: JSON.stringify({ [kid]: first.publicKey }) };
  for (const response of [undefined, {}, { ...valid, ARN: privateArn }, { ...valid, VersionId: privateVersion },
    { ...valid, SecretString: '' }, { ...valid, SecretBinary: new Uint8Array([1]) }, { ...valid, SecretString: 'x'.repeat(65_537) }]) {
    await fails(t, config, 'SECRET_RESPONSE_INVALID', { fetchSecret: async () => response });
  }
});

test('빈 파일·손상 PEM·작은 RSA·RSA 이외 공개키를 거부한다', async (t) => {
  for (const pem of ['', 'not-pem', first.publicKey.replace('PUBLIC KEY', 'RSA PUBLIC KEY'), weak.publicKey, ec.publicKey]) {
    await fails(t, config, 'PEM_INVALID', { fetchSecret: async (request) => ({ ARN: request.SecretId,
      VersionId: request.VersionId, SecretString: JSON.stringify({ [kid]: pem }) }) });
  }
});

test('개인키와 active kid의 공개키 불일치를 게시 전에 거부한다', async (t) => {
  await fails(t, signer, 'KEY_PAIR_MISMATCH', { fetchSecret: async (request) => ({ ARN: request.SecretId, VersionId: request.VersionId,
    SecretString: request.SecretId === privateArn ? second.privateKey : JSON.stringify({ [kid]: first.publicKey }) }) });
});

test('signer의 잘못된 PEM·1024bit·EC 개인키를 거부한다', async (t) => {
  for (const pem of ['broken', weak.privateKey, ec.privateKey]) await fails(t, signer, 'PEM_INVALID', {
    fetchSecret: async (request) => ({ ARN: request.SecretId, VersionId: request.VersionId,
      SecretString: request.SecretId === privateArn ? pem : JSON.stringify({ [kid]: first.publicKey }) }),
  });
});

test('SDK 예외 원문을 고정 실패 코드로 바꾸고 값을 보관하지 않는다', async (t) => {
  await fails(t, config, 'SECRET_FETCH_FAILED', { fetchSecret: async () => { throw new Error('SECRET_SENTINEL'); } });
  assert.equal(safeErrorCode(new Error('SECRET_SENTINEL')), 'WRITER_FAILED');
});

test('응답하지 않는 조회도 전체 deadline 내 실패하고 abort한다', async (t) => {
  let signal;
  await fails(t, config, 'DEADLINE_EXCEEDED', { deadlineMs: 25,
    fetchSecret: async (_request, options) => { signal = options.abortSignal; return new Promise(() => {}); } });
  assert.equal(signal.aborted, true);
});

test('deadline 뒤 도착한 응답은 최종·staging 파일을 만들지 않는다', async (t) => {
  const f = await fails(t, config, 'DEADLINE_EXCEEDED', { deadlineMs: 10,
    fetchSecret: async (request) => { await delay(40); return { ARN: request.SecretId, VersionId: request.VersionId,
      SecretString: JSON.stringify({ [kid]: first.publicKey }) }; } });
  await delay(60);
  assert.equal(fs.existsSync(f.rootDirectory), false);
});

test('volume root·상위 디렉터리 symlink와 기존 keys를 거부한다', async (t) => {
  const f = fixture(t);
  const destination = path.join(f.base, 'real');
  fs.mkdirSync(destination);
  fs.symlinkSync(destination, f.rootDirectory);
  await assert.rejects(runWriter(config, f.options), { code: 'PATH_UNSAFE' });
  fs.unlinkSync(f.rootDirectory);
  fs.mkdirSync(f.rootDirectory);
  fs.symlinkSync(destination, path.join(f.rootDirectory, 'keys'));
  await assert.rejects(runWriter(config, f.options), { code: 'PATH_UNSAFE' });
  assert.deepEqual(fs.readdirSync(destination), []);
  const parent = path.join(f.base, 'linked');
  fs.symlinkSync(f.base, parent);
  await assert.rejects(runWriter(config, { ...f.options, rootDirectory: path.join(parent, 'another') }), { code: 'PATH_UNSAFE' });
});

test('다른 프로세스가 쓸 수 있는 volume root는 거부한다', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.rootDirectory, { mode: 0o777 });
  fs.chmodSync(f.rootDirectory, 0o777);
  await assert.rejects(runWriter(config, f.options), { code: 'PATH_UNSAFE' });
});

test('파일 쓰기 실패는 staging을 지우고 최종 경로를 게시하지 않는다', async (t) => {
  const original = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('FILESYSTEM_SECRET_SENTINEL'); };
  try { await fails(t, config, 'FILESYSTEM_FAILED'); }
  finally { fs.fsyncSync = original; }
});

test('앱의 파일 읽기 권한이 없으면 실패하고 staging을 정리한다', { skip: process.getuid() === 0 }, async (t) => {
  const original = fs.fchmodSync;
  fs.fchmodSync = (descriptor) => original(descriptor, 0o000);
  try { await fails(t, config, 'FILE_ACCESS_FAILED'); }
  finally { fs.fchmodSync = original; }
});

test('한 번 게시한 volume은 기존 키를 덮어쓰지 않는다', async (t) => {
  const f = fixture(t);
  await runWriter(config, f.options);
  await assert.rejects(runWriter(config, f.options), { code: 'PATH_UNSAFE' });
  assert.equal(fs.readFileSync(path.join(f.rootDirectory, 'keys', 'public-0.pem'), 'utf8') === first.publicKey, true);
});

test('CLI는 유효하지 않은 입력에 고정 코드만 출력하고 1로 종료한다', () => {
  const executable = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  for (const value of ['', 'SECRET_SENTINEL', JSON.stringify({ ...config, key: 'SECRET_SENTINEL' })]) {
    const result = spawnSync(process.execPath, [executable], {
      encoding: 'utf8', env: { JWT_WRITER_CONFIG: value, AWS_EC2_METADATA_DISABLED: 'true' },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'CONFIG_INVALID\n');
  }
});

test('입력 정규화는 원래 kid와 alias를 보존한다', () => {
  assert.deepEqual(validateConfig(config).publicKeys, [{ kid, alias: 'public-0.pem' }]);
});

test('root 실행 환경에서는 실제 UID/GID 10001 child로 파일 읽기를 검증한다', { skip: process.getuid() !== 0 }, async (t) => {
  const f = fixture(t, { identity: { uid: 10001, gid: 10001 } });
  await runWriter(signer, f.options);
  const filename = path.join(f.rootDirectory, 'keys', 'private.pem');
  assert.equal(fs.statSync(filename).uid, 10001);
  assert.equal(fs.statSync(filename).gid, 10001);
});
