import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createSecretReader } from '../sdk.mjs';

const input = {
  SecretId: 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:test/public-ABC123',
  VersionId: 'a'.repeat(32),
};
const credentials = async () => ({ accessKeyId: 'mock-access-key', secretAccessKey: 'mock-secret-key' });

test('SDK는 지정 버전 요청을 유지하며 재시도 가능한 실패를 최대 세 번 시도한다', async () => {
  let calls = 0;
  let destroyed = false;
  const reader = createSecretReader('ap-northeast-2', {
    credentials,
    requestHandler: {
      handle: async (request) => {
        assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), input);
        calls++;
        return { response: {
          statusCode: 500,
          headers: { 'content-type': 'application/x-amz-json-1.1' },
          body: Readable.from([JSON.stringify({ __type: 'InternalServiceError', message: 'MOCK_SECRET_SENTINEL' })]),
        } };
      },
      destroy: () => { destroyed = true; },
    },
  });
  try { await assert.rejects(reader.fetchSecret(input, {})); }
  finally { reader.destroy(); }
  assert.equal(calls, 3);
  assert.equal(destroyed, true);
});

test('SDK는 권한 실패를 재시도하지 않는다', async () => {
  let calls = 0;
  const reader = createSecretReader('ap-northeast-2', {
    credentials,
    requestHandler: {
      handle: async () => {
        calls++;
        return { response: { statusCode: 400, headers: { 'content-type': 'application/x-amz-json-1.1' },
          body: Readable.from([JSON.stringify({ __type: 'AccessDeniedException', message: 'MOCK_SECRET_SENTINEL' })]) } };
      }, destroy() {},
    },
  });
  try { await assert.rejects(reader.fetchSecret(input, {})); }
  finally { reader.destroy(); }
  assert.equal(calls, 1);
});

test('SDK adapter는 전체 deadline의 abortSignal을 HTTP 처리로 전달한다', async () => {
  const controller = new AbortController();
  const reader = createSecretReader('ap-northeast-2', {
    credentials,
    requestHandler: {
      handle: async (_request, options) => {
        assert.equal(options.abortSignal, controller.signal);
        throw Object.assign(new Error('ABORTED'), { name: 'AbortError' });
      }, destroy() {},
    },
  });
  try { await assert.rejects(reader.fetchSecret(input, { abortSignal: controller.signal }), { name: 'AbortError' }); }
  finally { reader.destroy(); }
});
