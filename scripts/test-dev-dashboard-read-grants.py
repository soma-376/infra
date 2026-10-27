#!/usr/bin/env python3
"""전용 로컬 Docker PostgreSQL에서만 실행하는 PROJ-262 통합 검증."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

MODULE = Path(__file__).with_name('dev-dashboard-read-grants.py')
spec = importlib.util.spec_from_file_location('grants', MODULE)
grants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grants)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    # 이 도구는 로컬 검증용 역할/DDL과 GRANT를 실행하므로 원격/임의 컨테이너를 받지 않는다.
    if not args.container.startswith('soma-dev-seed-untuned-') or not args.container.endswith('-postgres-1'):
        raise ValueError('전용 로컬 untuned PostgreSQL 컨테이너만 허용합니다.')
    args.out.mkdir(parents=True, exist_ok=False)
    psql = ['docker', 'exec', '-i', args.container, 'psql', '-U', 'pulsemetry', '-d', 'pulsemetry',
            '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
    results = []

    def sql(statement, name, denied=False):
        result = subprocess.run(psql, input=statement, text=True, capture_output=True, timeout=45)
        passed = ('42501:' in result.stderr) if denied else result.returncode == 0
        results.append({'name': name, 'passed': passed, 'sqlstate': '42501' if '42501:' in result.stderr else None})
        if not passed:
            raise ValueError(f'{name}: 기대한 DB 결과와 다름 (exit {result.returncode})')
        return result

    def as_role(role, query, name, denied=False):
        # 예상 밖 허용도 업무 행을 commit하지 않는다.
        return sql(f'BEGIN; SET LOCAL statement_timeout=\'10s\'; SET LOCAL ROLE {grants.ident(role)};\n{query};\nROLLBACK;', name, denied)

    def tool(mode, directory):
        result = subprocess.run([sys.executable, str(MODULE), mode, '--database', 'pulsemetry',
            '--enrollment-role', 'proj262_enrollment_probe', '--docker-container', args.container,
            '--out', str(directory)], capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise ValueError(f'{mode} 실패: {result.stderr.strip()}')
        return json.loads(result.stdout)

    sql('CREATE ROLE proj262_enrollment_probe NOLOGIN;', 'create-local-probe')
    join = 'SELECT DISTINCT r.tenant_id FROM enrollment.organization_alert_rules r JOIN enrollment.alert_rule_definitions d USING(rule_id) WHERE r.enabled AND d.active LIMIT 0'
    as_role(grants.SOURCE, join, 'reproduce-enrollment-usage-missing', denied=True)
    initial = args.out / 'initial'
    prepared = tool('prepare', initial)
    sql((initial / 'apply.sql').read_text(), 'apply-minimal-grants')
    tool('verify', initial)
    as_role(grants.SOURCE, join, 'alert-evaluator-join')
    as_role(grants.SOURCE, 'SELECT s.*,m.*,t.status,t.oidc_issuer FROM enrollment.user_sessions s JOIN enrollment.members m ON m.id=s.member_id JOIN enrollment.tenants t ON t.id=m.tenant_id LIMIT 0', 'authentication-reader')
    as_role(grants.SOURCE, 'SELECT ' + ','.join(grants.VENDOR_COLUMNS) + ' FROM enrollment.vendor_connections WHERE deleted_at IS NULL LIMIT 0', 'vendor-public-columns')
    for table in grants.TABLES:
        as_role(grants.SOURCE, f'SELECT * FROM {table} LIMIT 0', 'read:' + table)
    as_role(grants.CACHE, 'SELECT policy_epoch FROM telemetry_ops.tenant_retention_boundary LIMIT 0', 'cache-retention-boundary')
    as_role('proj262_enrollment_probe', 'SELECT version FROM dashboard_cache.alerts WHERE qualified LIMIT 0', 'enrollment-alert-read')
    denied = [
        (grants.SOURCE, 'INSERT INTO enrollment.alert_rule_definitions DEFAULT VALUES', 'deny-insert'),
        (grants.SOURCE, 'UPDATE enrollment.organization_alert_rules SET enabled=enabled WHERE false', 'deny-update'),
        (grants.SOURCE, 'DELETE FROM enrollment.organization_alert_rules WHERE false', 'deny-delete'),
        (grants.SOURCE, 'TRUNCATE enrollment.organization_alert_rules', 'deny-truncate'),
        (grants.SOURCE, 'CREATE TABLE enrollment.proj262_denied(id int)', 'deny-schema-create'),
        (grants.SOURCE, 'SELECT credential_ciphertext,credential_key_id FROM enrollment.vendor_connections LIMIT 0', 'deny-vendor-credentials'),
        (grants.SOURCE, 'SELECT * FROM enrollment.vendor_connections LIMIT 0', 'deny-vendor-select-star'),
        (grants.SOURCE, 'SELECT * FROM dashboard_cache.alerts LIMIT 0', 'deny-source-cache-read'),
        (grants.CACHE, 'UPDATE telemetry_ops.tenant_retention_boundary SET policy_epoch=policy_epoch WHERE false', 'deny-cache-source-write'),
        ('proj262_enrollment_probe', 'UPDATE dashboard_cache.alerts SET version=version WHERE false', 'deny-enrollment-cache-write'),
    ]
    for table in ['user_refresh_tokens','user_authorization_codes','auth_attempts','installation_credentials','telemetry_tokens']:
        denied.append((grants.SOURCE, f'SELECT * FROM enrollment.{table} LIMIT 0', 'deny-secret:' + table))
    for role, query, name in denied:
        as_role(role, query, name, denied=True)
    as_role(grants.CACHE, 'UPDATE dashboard_cache.snapshots SET status=status WHERE false', 'cache-own-write-retained')
    repeated = tool('prepare', args.out / 'repeat')
    if repeated['missingGrants'] != 0:
        raise ValueError('두 번째 준비가 불필요한 grant를 만들었습니다.')
    sql((args.out / 'repeat' / 'apply.sql').read_text(), 'idempotent-noop')
    # ACL drift가 있는 rollback은 실패하며 새 grant도 원래 grant도 유지해야 한다.
    sql('GRANT SELECT ON enrollment.teams TO proj262_enrollment_probe;', 'fixture-acl-drift')
    drift = subprocess.run(psql, input=(initial / 'rollback.sql').read_text(), text=True, capture_output=True, timeout=45)
    if drift.returncode == 0 or 'catalog drift' not in drift.stderr:
        raise ValueError('rollback drift를 차단하지 못했습니다.')
    results.append({'name': 'rollback-drift-rejected', 'passed': True})
    sql('REVOKE SELECT ON enrollment.teams FROM proj262_enrollment_probe;', 'remove-fixture-drift')
    sql((initial / 'rollback.sql').read_text(), 'rollback-only-added-grants')
    restored = args.out / 'restored'
    tool('prepare', restored)
    before = json.loads((initial / 'before.json').read_text())
    now = json.loads((restored / 'before.json').read_text())
    if before != now:
        raise ValueError('rollback 후 기존 catalog/유효권한이 복원되지 않았습니다.')
    results.append({'name': 'rollback-catalog-identical', 'passed': True})
    as_role(grants.SOURCE, join, 'rollback-restores-original-denial', denied=True)
    sql((restored / 'apply.sql').read_text(), 'restore-fixed-local-state-for-e2e')
    tool('verify', restored)
    summary = {'ticket': 'PROJ-262', 'localOnly': True, 'database': 'pulsemetry',
        'container': args.container, 'sourceTables': len(grants.TABLES), 'vendorColumns': len(grants.VENDOR_COLUMNS),
        'initialMissingGrants': prepared['missingGrants'], 'repeatMissingGrants': repeated['missingGrants'],
        'checks': results, 'passed': all(r['passed'] for r in results),
        'finalState': 'minimal grants applied locally; probe role retained as fixture; dev unchanged'}
    (args.out / 'result.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'passed': summary['passed'], 'checks': len(results), 'result': str(args.out / 'result.json')}))


if __name__ == '__main__':
    main()
