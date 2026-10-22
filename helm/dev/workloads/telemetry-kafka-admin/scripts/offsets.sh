# consumer group이 비어 있을 때만 offset reset을 계획(--dry-run)하거나 실행(--execute)한다. (ADR-0036)
# Kafka 3.9 CLI는 실행 오류와 활성 group 거부를 `Error:` 줄로 출력만 하고 종료 코드 0으로 끝난다(ConsumerGroupCommand.run).
# 그래서 종료 코드가 아니라 `Error:` 줄과 `--export` CSV 행으로 판정하고, 실행 뒤에는 committed offset을 다시 읽어 계획과 대조한다.
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
  scope="$T"
  set -- --to-datetime "$OFFSETS_TO_DATETIME"
else
  scope="$T:$OFFSETS_PARTITION"
  set -- --to-offset "$OFFSETS_TO_OFFSET"
fi
fail() { echo "$1" >&2; exit 1; }
# reset 결과를 `topic,partition,offset` 정렬 행으로 rows에 남긴다. 오류 줄이 있거나 대상 행이 없으면 실패한다.
reset() {
  out=$("$KAFKA_BIN/kafka-consumer-groups.sh" --bootstrap-server "$B" --command-config "$C" --group "$G" \
    --reset-offsets --topic "$scope" "$@" 2>&1) || { printf '%s\n' "$out"; fail "kafka-consumer-groups가 실패했다"; }
  printf '%s\n' "$out"
  if printf '%s\n' "$out" | grep -q '^Error:'; then
    fail "offset reset이 오류를 출력했다. 종료 코드 0이어도 실패로 본다"
  fi
  rows=$(printf '%s\n' "$out" | awk -F, -v topic="$T" -v partition="${OFFSETS_PARTITION:-}" \
    'NF == 3 && $1 == topic && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && (partition == "" || $2 == partition)' | sort)
  [ -n "$rows" ] || fail "offset reset 결과에 $scope 행이 없다"
}
state=$("$KAFKA_BIN/kafka-consumer-groups.sh" --bootstrap-server "$B" --command-config "$C" --describe --group "$G" --state 2>&1)
printf '%s\n' "$state"
# 모든 Consumer를 중지해 group이 Empty(또는 offset이 없는 Dead)일 때만 진행한다.
if ! printf '%s\n' "$state" | grep -Eq "^$G[[:space:]].*[[:space:]](Empty|Dead)[[:space:]]" \
  && ! printf '%s\n' "$state" | grep -Fq "Consumer group '$G' does not exist."; then
  echo "group $G에 활성 Consumer가 있다. 모든 Consumer를 중지한 뒤 다시 실행한다." >&2
  exit 1
fi
reset "$@" --export "$action"
planned="$rows"
if [ "$OFFSETS_MODE" = execute ]; then
  # --to-current --dry-run은 group의 committed offset을 같은 CSV로 낸다. 그 사이 Consumer가 가입했으면 Error로 실패한다.
  reset --to-current --export --dry-run
  if [ "$rows" != "$planned" ]; then
    printf '계획:\n%s\ncommitted:\n%s\n' "$planned" "$rows" >&2
    fail "committed offset이 계획과 다르다"
  fi
  echo "committed offset이 계획과 같다."
fi
