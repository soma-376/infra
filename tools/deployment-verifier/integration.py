#!/usr/bin/env python3
"""격리된 로컬 PostgreSQL TLS·ClickHouse 읽기 권한과 실제 schema 지문을 검증하고 정리한다."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/deployment-verifier'))
from grants import statements

PG = 'docker.io/library/postgres@sha256:fb4a48f09f19618d307deb5d153a0b11768d37d5c3592ad0c63737dbe52c78ce'
CH = 'clickhouse/clickhouse-server@sha256:b002e56ed5c16e224c312527f6fcba7e77216fec5d7a88a7828f59efc614feb5'
IMAGE = 'pulsemetry-deployment-verifier:proj311-local'


def command(args, *, check=True, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if check and result.returncode:
        # fixture SQL만 처리하지만 기본 실패 보고에서도 서버 본문·자격을 복사하지 않는다.
        raise RuntimeError('local integration command failed: ' + args[0] + ' exit ' + str(result.returncode))
    return result


def main():
    suffix = uuid.uuid4().hex[:10]
    network, pg, ch = ['proj311-' + part + '-' + suffix for part in ('network', 'pg', 'ch')]
    containers = []
    try:
        command(['docker', 'network', 'create', '--internal', network])
        with tempfile.TemporaryDirectory(prefix='proj311-db-') as directory:
            path = Path(directory)
            path.chmod(0o755)
            command(['openssl', 'req', '-new', '-x509', '-nodes', '-days', '1', '-subj', '/CN=postgres',
                     '-keyout', str(path / 'server.key'), '-out', str(path / 'server.crt')])
            (path / 'server.key').chmod(0o644)  # 실제 자격이 아닌 이 시험만의 self-signed key다.
            pg_sql = "CREATE ROLE pulsemetry_deployment_reader LOGIN PASSWORD 'fixture-only';\n"
            for schema in ('enrollment', 'telemetry_ops', 'dashboard_cache'):
                pg_sql += f"CREATE SCHEMA {schema}; CREATE TABLE {schema}.flyway_schema_history(installed_rank int,version text,script text,checksum int,success boolean); "
                pg_sql += f"INSERT INTO {schema}.flyway_schema_history VALUES(1,'1','V1__fixture.sql',-123,true);\n"
            pg_sql += 'CREATE TABLE enrollment.source_payload(id bigint,payload text);\n' + statements(str(uuid.UUID(int=1)), str(uuid.UUID(int=2)))[0]
            (path / 'init.sql').write_text(pg_sql)
            command(['docker', 'run', '-d', '--name', pg, '--network', network, '--network-alias', 'postgres',
                     '-e', 'POSTGRES_PASSWORD=fixture-admin-only', '-e', 'POSTGRES_DB=controlplane',
                     '-v', directory + ':/fixture:ro', '-v', str(path / 'init.sql') + ':/docker-entrypoint-initdb.d/001.sql:ro',
                     '--entrypoint', 'sh', PG, '-c', 'cp /fixture/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/fixture/server.crt -c ssl_key_file=/tmp/server.key'])
            containers.append(pg)
            command(['docker', 'run', '-d', '--name', ch, '--network', network, '--network-alias', 'clickhouse',
                     '-e', 'CLICKHOUSE_USER=fixture_admin', '-e', 'CLICKHOUSE_PASSWORD=fixture-admin-only',
                     '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1', CH])
            containers.append(ch)
            pg_args = ['docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'controlplane', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c']
            ch_args = ['docker', 'exec', ch, 'clickhouse-client', '--user', 'fixture_admin', '--password', 'fixture-admin-only', '--multiquery', '--query']
            for _ in range(40):
                pg_ready = command(pg_args + ['SELECT count(*) FROM dashboard_cache.flyway_schema_history'], check=False)
                ch_ready = command(ch_args + ['SELECT 1'], check=False)
                if pg_ready.returncode == 0 and ch_ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('isolated database startup unavailable')
            sql = "CREATE USER pulsemetry_deployment_reader IDENTIFIED BY 'fixture-only' SETTINGS readonly=1,max_execution_time=10,max_result_rows=20000,result_overflow_mode='throw'; "
            sql += 'CREATE TABLE default.telemetry_events(observation_id String,tenant_id String,installation_id String,session_id String,request_id String,event_type String,tokens_input Int64,tokens_output Int64,archive_ref String) ENGINE=ReplacingMergeTree ORDER BY observation_id;\n'
            sql += statements(str(uuid.UUID(int=1)), str(uuid.UUID(int=2)))[1]
            command(ch_args + [sql])
            config = {'postgres': {'host': 'postgres', 'port': 5432, 'database': 'controlplane', 'sslmode': 'require'},
                      'clickhouse': {'origin': 'http://clickhouse:8123', 'database': 'default'}}
            credentials = {kind: {'username': 'pulsemetry_deployment_reader', 'password': 'fixture-only'} for kind in ('postgres', 'clickhouse')}
            (path / 'config.json').write_text(json.dumps(config))
            (path / 'probe.json').write_text(json.dumps(credentials))
            runner = ['docker', 'run', '--rm', '--network', network, '--read-only', '--tmpfs', '/tmp',
                      '-v', directory + ':/fixture:ro', '-v', str(ROOT / 'scripts/deployment-verifier') + ':/opt/verifier:ro',
                      '--entrypoint', 'python3', IMAGE]
            snapshot = runner + ['/opt/verifier/snapshot.py', '--config', '/fixture/config.json', '--credential-file', '/fixture/probe.json']
            first_run = command(snapshot, check=False)
            if first_run.returncode:
                # 고정 코드의 reason만 보이며 SQL·fixture 자격·DB body는 포함하지 않는다.
                print(first_run.stdout.decode(), flush=True)
            first = json.loads(command(snapshot).stdout)['schemaFingerprint']
            second = json.loads(command(snapshot).stdout)['schemaFingerprint']
            assert first == second
            command(pg_args + ['ALTER TABLE enrollment.source_payload ADD COLUMN next_schema integer'])
            assert json.loads(command(snapshot).stdout)['schemaFingerprint'] != first
            command(pg_args + ['ALTER TABLE enrollment.source_payload DROP COLUMN next_schema'])
            command(ch_args + ['ALTER TABLE default.telemetry_events ADD COLUMN next_schema Int64'])
            assert json.loads(command(snapshot).stdout)['schemaFingerprint'] != second
            # SELECT 권한이 없는 원천 row와 쓰기는 reader에게 열리지 않는다.
            denial_code = "import json; from snapshot import Sources,Unknown; s=Sources(json.load(open('/fixture/config.json')),json.load(open('/fixture/probe.json')));\nfor sql in ['SELECT row_to_json(x) FROM enrollment.source_payload x','DELETE FROM enrollment.flyway_schema_history RETURNING row_to_json(flyway_schema_history)']:\n try: s.pg(sql); raise AssertionError('unexpected source permission')\n except Unknown: pass\ntry: s.ch('SELECT * FROM default.telemetry_events FORMAT JSONEachRow'); raise AssertionError('unexpected source permission')\nexcept Unknown: pass\nassert s.ch('SELECT * FROM deployment_verification.telemetry_events FORMAT JSONEachRow')==[]\nprint('readonly_denials_passed')"
            command(runner + ['-c', "import sys; sys.path.insert(0,'/opt/verifier'); " + denial_code])
            command(pg_args + ['DROP TABLE dashboard_cache.flyway_schema_history'])
            missing = command(snapshot, check=False)
            assert missing.returncode == 2 and json.loads(missing.stdout)['result'] == 'unknown'
            print('PASS: ARM64 verifier, PostgreSQL TLS, ClickHouse definer view, actual PG/CH schema changes, readonly denials, missing history unknown')
    finally:
        for name in containers:
            command(['docker', 'rm', '-f', '-v', name], check=False)
        command(['docker', 'network', 'rm', network], check=False)


if __name__ == '__main__':
    main()
