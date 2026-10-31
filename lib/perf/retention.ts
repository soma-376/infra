import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/** 프로필의 CloudWatch 보존 일수를 enum으로 바꾼다. 프로필 검사기가 허용 값을 먼저 제한한다. */
export function perfLogRetention(days: number): RetentionDays {
  const value = (Object.values(RetentionDays) as unknown[]).find(item => item === days);
  if (value === undefined) throw new Error(`CloudWatch Logs가 지원하지 않는 보존 일수다: ${days}`);
  return value as RetentionDays;
}
