output "vpc_id" { value = aws_vpc.this.id }
output "vpc_cidr" { value = aws_vpc.this.cidr_block }
output "public_subnet_ids" { value = { for az, subnet in aws_subnet.public : az => subnet.id } }
output "private_subnet_ids" { value = { for az, subnet in aws_subnet.private : az => subnet.id } }
output "public_subnet_cidrs" { value = { for az, subnet in aws_subnet.public : az => subnet.cidr_block } }
output "private_subnet_cidrs" { value = { for az, subnet in aws_subnet.private : az => subnet.cidr_block } }
output "nat_gateway_id" { value = one(aws_nat_gateway.this[*].id) }
output "public_route_table_id" { value = aws_route_table.public.id }
output "private_route_table_ids" { value = { for az, table in aws_route_table.private : az => table.id } }
