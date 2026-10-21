# consumer group이 비어 있을 때만 offset reset을 계획(--dry-run)하거나 실행(--execute)한다. (ADR-0036)
set -eu
B="$PULSEMETRY_KAFKA_BOOTSTRAP_SERVERS"
T="$PULSEMETRY_KAFKA_TOPIC"
G="$PULSEMETRY_KAFKA_CONSUMER_GROUP"
C="$CLIENT_CONFIG"
case "$OFFSETS_MODE" in
  plan) action=--dry-run ;;
  execute) action=--execute ;;
  *) echo "OFFSETS_MODE는 plan 또는 execute여야 한다" >&2; exit 1 ;;
esac
if [ -n "${OFFSETS_TO_DATETIME:-}" ]; then
  set -- --topic "$T" --to-datetime "$OFFSETS_TO_DATETIME"
else
  set -- --topic "$T:$OFFSETS_PARTITION" --to-offset "$OFFSETS_TO_OFFSET"
fi
state=$("$KAFKA_BIN/kafka-consumer-groups.sh" --bootstrap-server "$B" --command-config "$C" --describe --group "$G" --state 2>&1)
printf '%s\n' "$state"
# 모든 Consumer를 중지해 group이 Empty(또는 offset이 없는 Dead)일 때만 진행한다.
if ! printf '%s\n' "$state" | grep -Eq "^$G[[:space:]].*[[:space:]](Empty|Dead)[[:space:]]" \
  && ! printf '%s\n' "$state" | grep -Fq "Consumer group '$G' does not exist."; then
  echo "group $G에 활성 Consumer가 있다. 모든 Consumer를 중지한 뒤 다시 실행한다." >&2
  exit 1
fi
"$KAFKA_BIN/kafka-consumer-groups.sh" --bootstrap-server "$B" --command-config "$C" --group "$G" --reset-offsets "$@" "$action"
if [ "$OFFSETS_MODE" = execute ]; then
  "$KAFKA_BIN/kafka-consumer-groups.sh" --bootstrap-server "$B" --command-config "$C" --describe --group "$G" --offsets
fi
