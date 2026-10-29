# Kafka CLI shell 안에서 읽는다. xtrace를 켜거나 비밀번호를 출력하지 않는다.
set +x
umask 077
for file in /mnt/kafka-tls/cluster/ca.p12 /mnt/kafka-tls/cluster/ca.password /mnt/kafka-tls/user/user.p12 /mnt/kafka-tls/user/user.password; do
  test -r "$file"
  test -s "$file"
done
# Strimzi의 영숫자 PKCS12 비밀번호만 허용해 Java properties escape가 필요한 입력을 거부한다.
ca_password=$(cat /mnt/kafka-tls/cluster/ca.password)
user_password=$(cat /mnt/kafka-tls/user/user.password)
case "$ca_password" in ''|*[!a-zA-Z0-9]*) echo 'invalid CA password format' >&2; exit 1;; esac
case "$user_password" in ''|*[!a-zA-Z0-9]*) echo 'invalid user password format' >&2; exit 1;; esac
{
  printf '%s\n' 'security.protocol=SSL' 'ssl.truststore.type=PKCS12' 'ssl.keystore.type=PKCS12' 'ssl.endpoint.identification.algorithm=https'
  printf '%s\n' 'ssl.truststore.location=/mnt/kafka-tls/cluster/ca.p12' 'ssl.keystore.location=/mnt/kafka-tls/user/user.p12'
  printf 'ssl.truststore.password=%s\nssl.keystore.password=%s\n' "$ca_password" "$user_password"
} > "$CLIENT_CONFIG"
unset ca_password user_password
trap 'rm -f "$CLIENT_CONFIG"' EXIT
