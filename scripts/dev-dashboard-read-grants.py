#!/usr/bin/env python3
"""PROJ-262: catalog 읽기와 검토용 SQL 생성만 수행한다. GRANT 실행 기능은 없다."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

SOURCE = 'dashboard_rds_source'
CACHE = 'dashboard_rds_cache'
TABLES = '''enrollment.alert_acknowledgements enrollment.alert_rule_definitions
enrollment.installation_collection_segments enrollment.installation_heartbeats
enrollment.installation_manifest_assignments enrollment.installations
enrollment.managed_vendors enrollment.manifests enrollment.members
enrollment.operation_targets enrollment.operations enrollment.organization_alert_rules
enrollment.organization_policy_settings enrollment.seat_assignment_events
enrollment.seat_assignments enrollment.seat_controls enrollment.team_memberships
enrollment.teams enrollment.tenants enrollment.user_sessions
enrollment.vendor_billing_periods enrollment.vendor_catalog_observed_products
enrollment.vendor_catalog_plans enrollment.vendor_catalog_products
enrollment.vendor_contract_versions telemetry_ops.retention_operations
telemetry_ops.tenant_ingest_summary telemetry_ops.tenant_retention_boundary
telemetry_ops.tenant_summary_backfill'''.split()
VENDOR_COLUMNS = '''id tenant_id vendor_id connector settings credential_updated_at
check_status checked_at last_sync_succeeded_at last_sync_failed_at last_sync_error
version created_at updated_at last_billing_succeeded_at last_billing_failed_at
last_billing_error deleted_at'''.split()
SCHEMAS = ('enrollment', 'telemetry_ops', 'dashboard_cache')


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def relation(value):
    return '.'.join(map(ident, value.split('.')))


def required(enrollment):
    # key 형식: 역할, 대상 종류, 대상 이름, 열 이름(없으면 빈 문자열), 권한.
    rows = [(SOURCE, 'schema', s, '', 'USAGE') for s in SCHEMAS[:2]]
    rows += [(SOURCE, 'table', t, '', 'SELECT') for t in TABLES]
    rows += [(SOURCE, 'column', 'enrollment.vendor_connections', c, 'SELECT') for c in VENDOR_COLUMNS]
    rows += [(CACHE, 'schema', 'telemetry_ops', '', 'USAGE'),
             (CACHE, 'table', 'telemetry_ops.tenant_retention_boundary', '', 'SELECT')]
    if enrollment:
        rows += [(enrollment, 'schema', 'dashboard_cache', '', 'USAGE'),
                 (enrollment, 'table', 'dashboard_cache.alerts', '', 'SELECT')]
    return rows


def snapshot_sql(roles):
    names = ','.join(map(literal, roles))
    schemas = ','.join(map(literal, SCHEMAS))
    # pg_roles에는 password 원문/해시가 없다. 업무 행은 한 건도 읽지 않는다.
    return f"""WITH r AS (SELECT * FROM pg_roles WHERE rolname IN ({names})),
    n AS (SELECT * FROM pg_namespace WHERE nspname IN ({schemas})),
    t AS (SELECT c.*, n.nspname || '.' || c.relname AS name FROM pg_class c JOIN n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f')),
    a AS (SELECT a.*, t.name FROM pg_attribute a JOIN t ON t.oid=a.attrelid WHERE a.attnum>0 AND NOT a.attisdropped),
    acl AS (
      SELECT jsonb_build_array('database',d.datname,'',x.grantor,x.grantee,x.privilege_type,x.is_grantable) item
      FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x WHERE d.datname=current_database()
      UNION ALL SELECT jsonb_build_array('schema',n.nspname,'',x.grantor,x.grantee,x.privilege_type,x.is_grantable)
      FROM n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) x
      UNION ALL SELECT jsonb_build_array('table',t.name,'',x.grantor,x.grantee,x.privilege_type,x.is_grantable)
      FROM t CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) x
      UNION ALL SELECT jsonb_build_array('column',a.name,a.attname,x.grantor,x.grantee,x.privilege_type,x.is_grantable)
      FROM a CROSS JOIN LATERAL aclexplode(a.attacl) x),
    checks AS (
      SELECT jsonb_build_array(r.rolname,'schema',n.nspname,'',p) k, has_schema_privilege(r.oid,n.oid,p) v FROM r CROSS JOIN n CROSS JOIN unnest(ARRAY['USAGE','CREATE']) p
      UNION ALL SELECT jsonb_build_array(r.rolname,'table',t.name,'',p),has_table_privilege(r.oid,t.oid,p) FROM r CROSS JOIN t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      UNION ALL SELECT jsonb_build_array(r.rolname,'column',a.name,a.attname,p),has_column_privilege(r.oid,a.attrelid,a.attnum,p) FROM r CROSS JOIN a CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
      UNION ALL SELECT jsonb_build_array(r.rolname,'database',current_database(),'',p),has_database_privilege(r.oid,current_database(),p) FROM r CROSS JOIN unnest(ARRAY['CONNECT','CREATE']) p)
    SELECT jsonb_build_object(
      'database', (SELECT jsonb_build_array(oid,datname,datdba,datacl) FROM pg_database WHERE datname=current_database()),
      'executor',current_user,
      'roles',(SELECT jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls) ORDER BY oid) FROM r),
      'memberships',(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb) FROM pg_auth_members m),
      'defaults',(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY oid),'[]'::jsonb) FROM pg_default_acl d),
      'default_grants',(SELECT COALESCE(jsonb_agg(jsonb_build_array(d.defaclrole,d.defaclnamespace,d.defaclobjtype,x.grantor,x.grantee,x.privilege_type,x.is_grantable) ORDER BY d.oid,x.grantee,x.privilege_type),'[]'::jsonb) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x),
      'schemas',(SELECT jsonb_agg(jsonb_build_array(oid,nspname,nspowner) ORDER BY oid) FROM n),
      'tables',(SELECT jsonb_agg(jsonb_build_array(oid,name,relowner,relkind) ORDER BY oid) FROM t),
      'columns',(SELECT jsonb_agg(jsonb_build_array(attrelid,attnum,name,attname,atttypid) ORDER BY attrelid,attnum) FROM a),
      'acl',(SELECT jsonb_agg(item ORDER BY item) FROM acl),
      'checks',(SELECT jsonb_agg(jsonb_build_array(k,v) ORDER BY k) FROM checks))"""


def check_map(state):
    return {tuple(k): v for k, v in state['checks']}


def validate(state, enrollment, complete=False):
    roles = {r[1]: r for r in state['roles'] or []}
    wanted = required(enrollment)
    checks = check_map(state)
    if any(role not in roles for role in [SOURCE, CACHE] + ([enrollment] if enrollment else [])):
        raise ValueError('필수 역할이 없습니다. 이 도구는 역할을 만들지 않습니다.')
    for role in (SOURCE, CACHE):
        row = roles[role]
        if row[2] or row[4] or row[5] or row[7]:
            raise ValueError(f'{role}: 관리자 역할 속성이 있습니다. 자동 회수하지 않습니다.')
    app_ids = {roles[SOURCE][0], roles[CACHE][0]}
    if any(m['member'] in app_ids for m in state['memberships']):
        # INHERIT=false여도 SET ROLE로 우회할 수 있으므로 membership 자체를 거부한다.
        raise ValueError('dashboard 역할에 role membership이 있습니다. 자동 회수하지 않습니다.')
    for kind, obj, col, grantor, grantee, privilege, grantable in state['acl']:
        own_cache = grantee == roles[CACHE][0] and (obj == 'dashboard_cache' or obj.startswith('dashboard_cache.'))
        if grantee in app_ids and grantable and not own_cache:
            raise ValueError('dashboard 역할에 원천 grant option이 있습니다. 자동 회수하지 않습니다.')
    tracked_namespaces = {n[0] for n in state['schemas']}
    cache_namespaces = {n[0] for n in state['schemas'] if n[1] == 'dashboard_cache'}
    for owner, namespace, kind, grantor, grantee, privilege, grantable in state['default_grants']:
        source_future = grantee == roles[SOURCE][0]
        cache_future_outside_cache = grantee == roles[CACHE][0] and namespace not in cache_namespaces
        public_source_future = grantee == 0 and (namespace == 0 or namespace in tracked_namespaces)
        if source_future or cache_future_outside_cache or public_source_future:
            raise ValueError('원천/전역 미래 객체의 default grant가 있습니다. 자동 회수하지 않습니다.')
    for key in wanted:
        if key not in checks:
            raise ValueError(f'필수 schema/table/column 없음: {key}')
        if complete and not checks[key]:
            raise ValueError(f'필수 조회 권한 누락: {key}')
    for key, enabled in checks.items():
        role, kind, obj, column, privilege = key
        if role not in (SOURCE, CACHE) or not enabled:
            continue
        own_cache = role == CACHE and (obj == 'dashboard_cache' or obj.startswith('dashboard_cache.'))
        if own_cache or (kind == 'database' and (privilege == 'CONNECT' or role == CACHE)):
            continue
        allowed = key in wanted
        if kind == 'column' and privilege == 'SELECT':
            allowed |= (role, 'table', obj, '', 'SELECT') in wanted
        if not allowed:
            raise ValueError(f'허용목록 밖의 유효 권한: {key}. 자동 REVOKE하지 않습니다.')
    # 과거 스키마의 password_hash를 m.* grant로 노출하지 않는다.
    if any(c[2:4] == ['enrollment.members', 'password_hash'] for c in state['columns']):
        raise ValueError('members.password_hash가 남아 있습니다. 최신 OIDC migration을 먼저 확인하세요.')
    return [k for k in wanted if not checks[k]]


def grant_sql(key, verb='GRANT'):
    role, kind, obj, column, privilege = key
    selected = privilege + (' (' + ident(column) + ')' if kind == 'column' else '')
    target = ('SCHEMA ' + ident(obj)) if kind == 'schema' else ('TABLE ' + relation(obj))
    return f'{verb} {selected} ON {target} {"TO" if verb == "GRANT" else "FROM"} {ident(role)};'


def predicate(key):
    role, kind, obj, column, privilege = key
    args = [role, obj] + ([column] if kind == 'column' else []) + [privilege]
    return f'has_{kind}_privilege(' + ','.join(map(literal, args)) + ')'


def transaction(query, baseline, statements, assertions):
    expected = literal(json.dumps(baseline, separators=(',', ':')))
    guards = '\n'.join(f'IF NOT ({p}) THEN RAISE EXCEPTION \'PROJ-262 권한 검증 실패\'; END IF;' for p in assertions)
    body = f"""BEGIN
  IF ({query}) IS DISTINCT FROM {expected}::jsonb THEN
    RAISE EXCEPTION 'PROJ-262 catalog drift: 새 prepare가 필요합니다';
  END IF;
END"""
    def block(text):
        tag = '$proj262$'
        while tag in text:
            tag = tag[:-1] + '_x$'
        return f'DO {tag} {text} {tag};'
    return f"""-- PROJ-262. 사전 상태가 달라지면 재검토한다. 비밀번호/업무 데이터는 포함하지 않는다.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog;
SELECT pg_advisory_xact_lock(262, 1);
{block(body)}
{chr(10).join(statements)}
{block('BEGIN' + chr(10) + guards + chr(10) + 'END')}
COMMIT;
"""


def read_state(args, query):
    command = [args.psql_bin, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-d', args.database]
    if args.docker_container:
        command = ['docker', 'exec', '-i', args.docker_container, 'psql', '-U', args.docker_user] + command[1:]
    result = subprocess.run(command, input="BEGIN READ ONLY; SET LOCAL statement_timeout='30s'; SET LOCAL search_path=pg_catalog;\n" + query + ';\nROLLBACK;\n', capture_output=True, text=True, timeout=40)
    if result.returncode:
        # 접속 환경·오류문이 자격증명을 포함할 가능성을 피해 원문 stderr를 출력하지 않는다.
        raise ValueError(f'읽기 전용 catalog 조회 실패 (psql exit {result.returncode})')
    return json.loads(result.stdout)


def save(path, value):
    text = value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False) + '\n'
    # verify 도중 연결/프로세스가 끊겨도 동일 증빙은 재사용한다. 다른 기준점은 덮어쓰지 않는다.
    if path.exists():
        if path.read_text() == text:
            return
        raise ValueError(f'기존 증빙과 내용이 다릅니다: {path.name}')
    with path.open('x') as handle:
        os.chmod(path, 0o600)
        handle.write(text)


def validate_delta(before, after, missing):
    # 검증/rollback 파일은 실제 관측한 추가분에만 근거한다.
    if before.keys() != after.keys():
        raise ValueError('catalog 증빙 형식이 다릅니다. 같은 도구 버전으로 다시 검토하세요.')
    for key in before:
        if key not in ('acl', 'checks') and before[key] != after[key]:
            raise ValueError(f'적용 중 catalog 변경: {key}')
    old = {tuple(x) for x in before['acl']}
    new = {tuple(x) for x in after['acl']}
    if not old <= new:
        raise ValueError('기존 ACL이 제거/변경되었습니다. 자동 복구 SQL을 만들지 않습니다.')
    roles = {r[1]: r[0] for r in before['roles']}
    allowed = {(kind, obj, col, roles[role], privilege) for role, kind, obj, col, privilege in missing}
    for kind, obj, col, grantor, grantee, privilege, grantable in new - old:
        if (kind, obj, col, grantee, privilege) not in allowed or grantable:
            raise ValueError('계획 밖 ACL 추가가 있습니다. 자동 복구 SQL을 만들지 않습니다.')
    expected = check_map(before)
    for role, kind, obj, col, privilege in missing:
        expected[(role, kind, obj, col, privilege)] = True
        if kind == 'table':
            for key in expected:
                if key[0] == role and key[1] == 'column' and key[2] == obj and key[4] == privilege:
                    expected[key] = True
    if expected != check_map(after):
        raise ValueError('계획 밖 유효 권한 변경이 있습니다.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'verify'))
    parser.add_argument('--database', required=True)
    parser.add_argument('--enrollment-role', required=True, help='실제 runtime 역할. 추정하지 말고 현재 연결에서 확인한다.')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--psql-bin', default='psql')
    parser.add_argument('--docker-container', help='로컬 검증 전용. 기존 컨테이너는 바꾸지 않는다.')
    parser.add_argument('--docker-user', default='pulsemetry')
    args = parser.parse_args()
    os.umask(0o077)
    if args.enrollment_role in (SOURCE, CACHE):
        raise ValueError('enrollment와 dashboard runtime 역할이 같으면 안 됩니다.')
    query = snapshot_sql([SOURCE, CACHE, args.enrollment_role])
    state = read_state(args, query)
    if state['database'][1] != args.database:
        raise ValueError('DB 이름 불일치')
    missing = validate(state, args.enrollment_role, complete=args.mode == 'verify')
    args.out.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.mode == 'prepare':
        if (args.out / 'before.json').exists():
            raise ValueError('출력 디렉터리를 재사용하지 마세요. 기존 기준점을 보존합니다.')
        save(args.out / 'before.json', state)
        save(args.out / 'plan.json', {'ticket': 'PROJ-262', 'database': args.database,
             'enrollmentRole': args.enrollment_role, 'missing': missing, 'sqlExecutedByTool': False})
        # 거부되는 모든 권한도 트랜잭션 안에서 보존 확인한다.
        denied = ['NOT ' + predicate(k) for k, value in check_map(state).items()
                  if not value and k not in missing and k[0] in (SOURCE, CACHE)
                  and not (k[1] == 'column' and (k[0], 'table', k[2], '', k[4]) in missing)]
        save(args.out / 'apply.sql', transaction(query, state, [grant_sql(k) for k in missing],
             [predicate(k) for k in required(args.enrollment_role)] + denied))
        print(json.dumps({'mode': 'prepare', 'missingGrants': len(missing), 'sqlExecuted': False}))
    else:
        before = json.loads((args.out / 'before.json').read_text())
        plan = json.loads((args.out / 'plan.json').read_text())
        if plan['database'] != args.database or plan['enrollmentRole'] != args.enrollment_role:
            raise ValueError('prepare 대상과 verify 대상이 다릅니다.')
        original_missing = [tuple(k) for k in plan['missing']]
        validate_delta(before, state, original_missing)
        save(args.out / 'after.json', state)
        # 원래 없던 직접 grant만 회수한다. 기존 grant·owner·password·default ACL은 건드리지 않는다.
        save(args.out / 'rollback.sql', transaction(query, state,
             [grant_sql(k, 'REVOKE') for k in reversed(original_missing)],
             [predicate(k) if v else 'NOT ' + predicate(k) for k, v in check_map(before).items()]))
        save(args.out / 'verification.json', {'ticket': 'PROJ-262', 'minimalPrivileges': True,
             'existingAclPreserved': True, 'rollbackReady': True, 'newGrants': len(original_missing)})
        print(json.dumps({'mode': 'verify', 'minimalPrivileges': True, 'rollbackReady': True}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
