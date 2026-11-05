#!/usr/bin/env python3
"""실제 고정 Kafka·exporter·Prometheus의 ACK 이후 fresh offset 증명을 격리 검증한다."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
from integration import command, ROOT, IMAGE

KAFKA = 'quay.io/strimzi/kafka@sha256:b9b9e37491ce17c1b2722b3668661de91430d9437acf18c5f5bafaef38138652'
PROM = 'quay.io/prometheus/prometheus:v3.9.1@sha256:1f0f50f06acaceb0f5670d2c8a658a599affe7b0d8e78b898c1035653849a702'
TOPIC, GROUP = 'proj311-synthetic', 'proj311-verifier'
READ = '''import json,sys,time,urllib.parse
sys.path.insert(0,'/opt/verifier')
from verify import Verifier
from snapshot import http,Unknown
class LocalProm:
 def kube(self,path):
  suffix=path.split('/proxy',1)[1]
  status,body,_=http('http://prometheus:9090'+suffix)
  if status!=200: raise Unknown('local_prometheus_unavailable')
  return json.loads(body)
cfg={'prometheus':{'namespace':'pulsemetry-observability','proxyName':'fixture:9090','topic':'proj311-synthetic','consumerGroup':'proj311-verifier','exporterJob':'exporter','collectionMaxSeconds':1,'scrapeIntervalSeconds':1}}
v=Verifier({}, {},cfg,{},LocalProm())
deadline=time.monotonic()+45
while time.monotonic()<deadline:
 try:
  result=v.offsets(sys.argv[1]=='committed',float(sys.argv[2]))
  print(json.dumps({'vector':result[0],'instance':result[1]}));sys.exit(0)
 except Unknown: time.sleep(1)
print('unknown');sys.exit(2)
'''


def main():
    suffix = uuid.uuid4().hex[:10]
    network, kafka, exporter, prometheus = ['proj311-' + kind + '-' + suffix for kind in ('knet', 'kafka', 'exporter', 'prom')]
    containers = []
    try:
        command(['docker', 'network', 'create', '--internal', network])
        with tempfile.TemporaryDirectory(prefix='proj311-kafka-') as directory:
            path = Path(directory)
            path.chmod(0o755)
            (path / 'kafka.properties').write_text('''process.roles=broker,controller
node.id=1
controller.quorum.voters=1@kafka:9093
controller.listener.names=CONTROLLER
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
advertised.listeners=PLAINTEXT://kafka:9092
listener.security.protocol.map=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
inter.broker.listener.name=PLAINTEXT
log.dirs=/tmp/kraft-logs
offsets.topic.replication.factor=1
transaction.state.log.replication.factor=1
transaction.state.log.min.isr=1
auto.create.topics.enable=false
num.partitions=3
''')
            (path / 'prometheus.yml').write_text('''global:
  scrape_interval: 1s
  scrape_timeout: 1s
scrape_configs:
  - job_name: exporter
    static_configs:
      - targets: [exporter:9308]
''')
            (path / 'read.py').write_text(READ)
            command(['docker', 'run', '-d', '--name', kafka, '--network', network, '--network-alias', 'kafka',
                     '-e', 'KAFKA_HEAP_OPTS=-Xms256m -Xmx512m', '-e', 'LOG_DIR=/tmp/kafka-logs', '-v', directory + ':/fixture:ro', '--entrypoint', '/bin/bash', KAFKA,
                     '-ec', '/opt/kafka/bin/kafka-storage.sh format -t "$(/opt/kafka/bin/kafka-storage.sh random-uuid)" -c /fixture/kafka.properties && exec /opt/kafka/bin/kafka-server-start.sh /fixture/kafka.properties'])
            containers.append(kafka)
            admin = ['docker', 'exec', kafka, '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:9092']
            for _ in range(30):
                if command(admin + ['--list'], check=False).returncode == 0:
                    break
                time.sleep(1)
            else:
                # 인증·사용자 데이터가 없는 로컬 fixture의 기동 오류만 진단한다.
                diagnostics = command(['docker', 'logs', '--tail', '20', kafka], check=False)
                print((diagnostics.stdout + diagnostics.stderr).decode()[-3000:], flush=True)
                raise RuntimeError('isolated Kafka startup unavailable')
            command(admin + ['--create', '--topic', TOPIC, '--partitions', '3', '--replication-factor', '1'])
            command(['docker', 'run', '-d', '--name', exporter, '--network', network, '--network-alias', 'exporter', '--entrypoint', '/opt/kafka-exporter/kafka_exporter',
                     KAFKA, '--kafka.server=kafka:9092', '--kafka.version=4.2.2', '--topic.filter=^' + TOPIC + '$', '--group.filter=^' + GROUP + '$', '--refresh.metadata=1s'])
            containers.append(exporter)
            command(['docker', 'run', '-d', '--name', prometheus, '--network', network, '--network-alias', 'prometheus', '-v', directory + ':/fixture:ro',
                     PROM, '--config.file=/fixture/prometheus.yml', '--storage.tsdb.path=/prometheus'])
            containers.append(prometheus)
            producer = ['docker', 'exec', '-i', kafka, '/opt/kafka/bin/kafka-console-producer.sh', '--bootstrap-server', 'kafka:9092', '--topic', TOPIC,
                        '--sync', '--producer-property', 'partitioner.class=org.apache.kafka.clients.producer.RoundRobinPartitioner']
            consumer = ['docker', 'exec', kafka, '/opt/kafka/bin/kafka-console-consumer.sh', '--bootstrap-server', 'kafka:9092', '--topic', TOPIC,
                        '--group', GROUP, '--from-beginning', '--timeout-ms', '20000']
            command(producer, data=b'seed0\nseed1\nseed2\nseed3\nseed4\nseed5\n')
            command(consumer + ['--max-messages', '6'])
            runner = ['docker', 'run', '--rm', '--network', network, '--read-only', '--tmpfs', '/tmp', '-v', directory + ':/fixture:ro',
                      '-v', str(ROOT / 'scripts/deployment-verifier') + ':/opt/verifier:ro', '--entrypoint', 'python3', IMAGE, '/fixture/read.py']
            command(runner + ['committed', str(time.time())])
            command(producer, data=b'one-new-synthetic-probe\n')
            ack = time.time()
            end = json.loads(command(runner + ['end', str(ack + 2)]).stdout)
            before = json.loads(command(runner + ['committed', str(ack + 2)]).stdout)
            assert len(end['vector']) == 3 and end['instance'] == before['instance']
            assert any(before['vector'][partition] < offset for partition, offset in end['vector'].items())
            command(consumer + ['--max-messages', '1'])
            after = json.loads(command(runner + ['committed', str(time.time())]).stdout)
            assert all(after['vector'][partition] >= offset for partition, offset in end['vector'].items())
            command(['docker', 'stop', exporter])
            unavailable = command(runner + ['end', str(time.time())], check=False)
            assert unavailable.returncode == 2
            print('PASS: Kafka 4.2.2 ACK then fresh 3-partition vector; uncommitted probe rejected; real commit accepted; stopped exporter unknown')
    finally:
        for name in reversed(containers):
            command(['docker', 'rm', '-f', '-v', name], check=False)
        command(['docker', 'network', 'rm', network], check=False)


if __name__ == '__main__':
    main()
