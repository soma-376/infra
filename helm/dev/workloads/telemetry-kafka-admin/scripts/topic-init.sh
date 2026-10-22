# ingress topic을 없을 때만 만들고 실제 설정을 계약값과 대조한다. 다르면 실패하며 자동 재생성하지 않는다. (ADR-0035)
set -eu
B="$PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS"
T="$PULSEMETRY_KAFKA_TOPIC"
C="$CLIENT_CONFIG"
EXPECTED="min.insync.replicas=2 retention.ms=259200000 cleanup.policy=delete max.message.bytes=13631488 unclean.leader.election.enable=false"
create_configs=""
for entry in $EXPECTED; do create_configs="$create_configs --config $entry"; done
# shellcheck disable=SC2086
"$KAFKA_BIN/kafka-topics.sh" --bootstrap-server "$B" --command-config "$C" --create --if-not-exists \
  --topic "$T" --partitions 6 --replication-factor 3 $create_configs
summary=$("$KAFKA_BIN/kafka-topics.sh" --bootstrap-server "$B" --command-config "$C" --describe --topic "$T" | head -n 1)
configs=$("$KAFKA_BIN/kafka-configs.sh" --bootstrap-server "$B" --command-config "$C" --describe --entity-type topics --entity-name "$T" --all)
failed=0
printf '%s\n' "$summary" | grep -Eq "PartitionCount:[[:space:]]*6([[:space:]]|$)" || { echo "불일치: partition 수가 6이 아니다"; failed=1; }
printf '%s\n' "$summary" | grep -Eq "ReplicationFactor:[[:space:]]*3([[:space:]]|$)" || { echo "불일치: replication factor가 3이 아니다"; failed=1; }
for entry in $EXPECTED; do
  # 각 줄의 첫 field가 실제 topic 값이다. synonyms의 broker 기본값과 혼동하지 않는다.
  printf '%s\n' "$configs" | awk -v expected="$entry" '$1 == expected { found = 1 } END { exit !found }' \
    || { echo "불일치: ${entry%%=*}"; failed=1; }
done
if [ "$failed" -ne 0 ]; then
  echo "topic $T 설정이 계약과 다르다. 자동 재생성·변경하지 않는다. 런북의 수동 확인 절차를 따른다." >&2
  exit 1
fi
echo "topic $T 설정 대조 통과: partition 6, RF 3, $EXPECTED"
