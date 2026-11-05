#!/usr/bin/env python3
"""운영자가 검토할 최소 읽기 권한 SQL만 출력한다. 사용자 생성·암호·GRANT 실행은 하지 않는다."""
import argparse
import uuid


def statements(tenant, installation):
    tenant, installation = str(uuid.UUID(tenant)), str(uuid.UUID(installation))
    pg = ['-- PostgreSQL: 별도로 준비한 LOGIN 역할에 적용한다. owner 앱 계정을 재사용하지 않는다.',
          'ALTER ROLE pulsemetry_deployment_reader SET default_transaction_read_only = on;',
          'GRANT CONNECT ON DATABASE controlplane TO pulsemetry_deployment_reader;']
    for schema in ('enrollment', 'telemetry_ops', 'dashboard_cache'):
        pg += [f'GRANT USAGE ON SCHEMA {schema} TO pulsemetry_deployment_reader;',
               f'GRANT SELECT ON {schema}.flyway_schema_history TO pulsemetry_deployment_reader;']
    ch = ['-- ClickHouse: 별도 읽기 전용 profile·사용자와 DB owner가 view를 준비한다.',
          'CREATE DATABASE IF NOT EXISTS deployment_verification;',
          "CREATE VIEW deployment_verification.telemetry_events SQL SECURITY DEFINER AS "
          "SELECT observation_id,tenant_id,installation_id,session_id,request_id,event_type,tokens_input,tokens_output,archive_ref "
          "FROM default.telemetry_events FINAL WHERE tenant_id='" + tenant + "' AND installation_id='" + installation + "';",
          'GRANT SELECT ON deployment_verification.telemetry_events TO pulsemetry_deployment_reader;',
          'GRANT SELECT(database,name,engine,create_table_query) ON system.tables TO pulsemetry_deployment_reader;',
          'GRANT SHOW TABLES ON default.* TO pulsemetry_deployment_reader;',
          'GRANT SHOW TABLES ON dashboard_cache.* TO pulsemetry_deployment_reader;',
          "-- profile readonly=1, max_execution_time=10, max_result_rows=20000, result_overflow_mode='throw'를 운영자가 고정한다.",
          '-- 원천 SELECT·S3 GetObject·INSERT·ALTER·Kafka consumer 인증을 부여하지 않는다.']
    return '\n'.join(pg) + '\n', '\n'.join(ch) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tenant', required=True)
    parser.add_argument('--installation', required=True)
    parser.add_argument('--database', choices=['postgres', 'clickhouse'], required=True)
    args = parser.parse_args()
    print(statements(args.tenant, args.installation)[args.database == 'clickhouse'], end='')


if __name__ == '__main__':
    main()
