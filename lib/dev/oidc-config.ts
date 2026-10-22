import { App } from 'aws-cdk-lib/core';

/** CDK는 OIDC 원본 목록만 소유하고, 활성 여부·버전·callback은 Helm runtime이 소유한다. */
export function loadDevOidcClientKeys(app: App): readonly string[] {
  const raw: unknown = app.node.tryGetContext('devOidcClientKeys');
  let keys: unknown = raw;
  if (typeof raw === 'string') {
    try { keys = JSON.parse(raw); }
    catch { throw new Error('devOidcClientKeys는 JSON 문자열 배열이어야 한다. 원본이 없으면 []를 명시하세요'); }
  }
  if (!Array.isArray(keys) || keys.length > 32 || keys.some(key =>
    typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) || new Set(keys).size !== keys.length) {
    throw new Error('devOidcClientKeys는 중복 없는 최대 32개의 key 배열이 필요하다. key는 영숫자·_·- 1~64자이며 원본이 없으면 []를 명시하세요');
  }
  return [...keys].sort();
}
