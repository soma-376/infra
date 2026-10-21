locals {
  name          = "pulsemetry-frontend-${var.environment}"
  tags          = { Org = "soma-376", Project = "pulsemetry-frontend", Env = var.environment, ManagedBy = "terraform" }
  zones         = { for index, az in var.availability_zones : az => index }
  private_zones = var.environment == "prod" ? local.zones : {}
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = local.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = local.name })
}

resource "aws_subnet" "public" {
  for_each          = local.zones
  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value)
  # EC2 생성 단계에서 필요한 경우에만 명시적으로 public IP를 할당한다.
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${local.name}-public-${each.key}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${local.name}-public" })
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each       = local.zones
  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}

resource "aws_subnet" "private" {
  for_each                = local.private_zones
  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 16 + each.value)
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${local.name}-private-${each.key}" })
}

resource "aws_eip" "nat" {
  count  = var.environment == "prod" ? 1 : 0
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name}-nat" })
}

resource "aws_nat_gateway" "this" {
  count             = var.environment == "prod" ? 1 : 0
  allocation_id     = aws_eip.nat[0].id
  subnet_id         = aws_subnet.public[var.availability_zones[0]].id
  connectivity_type = "public"
  tags              = merge(local.tags, { Name = "${local.name}-nat" })
  depends_on        = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  for_each = local.private_zones
  vpc_id   = aws_vpc.this.id
  tags     = merge(local.tags, { Name = "${local.name}-private-${each.key}" })
}

resource "aws_route" "nat" {
  for_each               = local.private_zones
  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "private" {
  for_each       = local.private_zones
  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}
