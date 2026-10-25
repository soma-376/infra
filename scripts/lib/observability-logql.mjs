import assert from 'node:assert/strict';

// LogQL 전체 문법 대신 대시보드의 첫 stream 선택자와 label 허용목록을 검사한다.
export function validateLokiSelector(expression, allowedLabels) {
  // 큰따옴표의 escape와 백틱 raw 문자열을 통째로 건너뛴다. raw 문자열의 백슬래시는 escape가 아니다.
  const selector = expression.match(/^\{((?:"(?:[^"\\]|\\.)*"|`[^`]*`|[^}"`])*)\}/)?.[1];
  assert.notEqual(selector, undefined, `Loki 선택자 형식: ${expression}`);
  for (const label of ['environment="$environment"', 'cluster="$cluster"']) {
    assert.ok(selector.includes(label), `Loki 선택자 ${label}: ${expression}`);
  }
  const withoutValues = selector.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""');
  for (const [, label] of withoutValues.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)/g)) {
    assert.ok(allowedLabels.has(label), `Loki label 허용목록 밖: ${label}`);
  }
}
