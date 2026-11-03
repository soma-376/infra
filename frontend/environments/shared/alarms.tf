locals {
  alarms = {
    storage   = { metric = "BytesUsedForCache", statistic = "Maximum", threshold = var.max_storage_gb * 1000000000 * 0.75 }
    compute   = { metric = "ElastiCacheProcessingUnits", statistic = "Sum", threshold = var.max_ecpu_per_second * 60 * 0.75 }
    throttled = { metric = "ThrottledCmds", statistic = "Sum", threshold = 1 }
    evicted   = { metric = "Evictions", statistic = "Sum", threshold = 1 }
  }
}
resource "aws_cloudwatch_metric_alarm" "cache" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "Shared BFF cache capacity or session eviction; not a monthly billing cap"
  namespace           = "AWS/ElastiCache"
  metric_name         = each.value.metric
  dimensions          = { ServerlessCacheName = aws_elasticache_serverless_cache.bff.name }
  statistic           = each.value.statistic
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  ok_actions          = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  tags                = local.tags
}
