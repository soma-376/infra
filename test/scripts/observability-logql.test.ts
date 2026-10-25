import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(__dirname, '../../scripts/lib/observability-logql.mjs')).href;
const prefix = '{environment="$environment",cluster="$cluster",';
const validate = (expression: string) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { readFileSync } from 'node:fs';
  import { validateLokiSelector } from ${JSON.stringify(moduleUrl)};
  validateLokiSelector(JSON.parse(readFileSync(0, 'utf8')), new Set(['environment', 'cluster', 'namespace', 'service_name', 'container']));
`], { input: JSON.stringify(expression), encoding: 'utf8' });

describe('Loki 선택자 label 검증', () => {
  test.each([
    ['백틱 안의 닫는 중괄호', 'service_name=~`x}y`'],
    ['백틱 안의 큰따옴표와 label처럼 보이는 값', 'service_name=`x"tenant_id="hidden"}y`'],
    ['백틱 안의 백슬래시', 'service_name=~`\\d+}x`'],
    ['백틱 직전의 백슬래시', 'service_name=`x}\\`,container="app"'],
    ['백틱 안의 줄바꿈', 'service_name=`x\n}y`'],
    ['큰따옴표 안의 Grafana 변수', 'service_name=~"${service:regex}"'],
    ['큰따옴표 안의 escape와 백틱', 'service_name="x\\\"}\\\\`tenant_id=y"'],
  ])('%s는 label로 오인하지 않는다', (_name, matcher) => {
    const result = validate(prefix + matcher + '} |= "tenant_id=log-body"');
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  });

  test.each(['=', '=~', '!=', '!~'])('백틱 안의 } 뒤에 오는 금지 label(%s)을 거부한다', operator => {
    const result = validate(prefix + 'service_name=~`x}y`,tenant_id' + operator + '"hidden"}');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Loki label 허용목록 밖: tenant_id');
  });

  test('백틱 직전 백슬래시를 escape로 읽어 뒤의 금지 label을 놓치지 않는다', () => {
    const result = validate(prefix + 'service_name=`x}\\`,tenant_id="hidden"}');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Loki label 허용목록 밖: tenant_id');
  });

  test('큰따옴표 변수 뒤의 금지 label도 계속 거부한다', () => {
    const result = validate(prefix + 'service_name=~"${service:regex}",tenant_id="hidden"}');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Loki label 허용목록 밖: tenant_id');
  });

  test.each(['service_name=`x}y', 'service_name="x}y'])('닫히지 않은 문자열을 선택자 끝으로 오인하지 않는다: %s', matcher => {
    const result = validate(prefix + matcher + '}');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Loki 선택자 형식');
  });
});
