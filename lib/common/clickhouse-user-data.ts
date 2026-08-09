/**
 * ClickHouse 데이터 볼륨(xvdb) 포맷 + /data/clickhouse 마운트 userData.
 *
 * Nitro 인스턴스에서는 /dev/xvdb symlink 가 없을 수 있어 lsblk 로 미마운트
 * 데이터 디바이스를 탐색하는 폴백을 둔다. blkid 가드로 idempotent 하게 만들고
 * /etc/fstab 에 등록해 재부팅 후에도 유지되게 한다.
 *
 * prod/dev 가 같은 스크립트를 쓰므로 환경 무관 모듈에 둔다. 이 문자열 배열이
 * 그대로 LaunchTemplate 의 UserData 가 되므로 한 글자만 바뀌어도 합성 산출물이
 * 달라진다.
 */
export function clickhouseUserData(): string[] {
  return [
    'set -euxo pipefail',
    'MOUNT=/data/clickhouse',
    'mkdir -p "$MOUNT"',
    // 우선 /dev/xvdb, 없으면 lsblk 로 마운트되지 않은 빈 디스크를 찾는다.
    'DEV=/dev/xvdb',
    'if [ ! -b "$DEV" ]; then',
    "  DEV=$(lsblk -rpno NAME,TYPE,MOUNTPOINT | awk '$2==\"disk\" && $3==\"\" {print $1}' | grep -v -E 'nvme0n1$|xvda$' | head -n1)",
    'fi',
    'if [ -z "$DEV" ]; then echo "no data device found" >&2; exit 1; fi',
    // 파일시스템이 없을 때만 포맷 (idempotent).
    'if ! blkid "$DEV"; then mkfs -t xfs "$DEV"; fi',
    'UUID=$(blkid -s UUID -o value "$DEV")',
    'grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $MOUNT xfs defaults,nofail 0 2" >> /etc/fstab',
    'mountpoint -q "$MOUNT" || mount "$MOUNT"',
  ];
}
