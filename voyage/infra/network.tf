# A separate, well-designed network for Vespera: one public subnet for internet-facing parts,
# and private subnets, which have no route to the internet.
# Creating it does not touch the running server, which stays in the default VPC.
# All of these resources are free.

resource "aws_vpc" "vespera" {
  cidr_block           = "10.10.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "vespera-vpc"
  }
}

resource "aws_internet_gateway" "vespera" {
  vpc_id = aws_vpc.vespera.id

  tags = {
    Name = "vespera-igw"
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.vespera.id
  cidr_block              = "10.10.1.0/24"
  availability_zone       = "ap-south-1a"
  map_public_ip_on_launch = false

  tags = {
    Name = "vespera-public-a"
    Tier = "public"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.vespera.id
  cidr_block        = "10.10.10.0/24"
  availability_zone = "ap-south-1a"

  tags = {
    Name = "vespera-private-a"
    Tier = "private"
  }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.vespera.id
  cidr_block        = "10.10.11.0/24"
  availability_zone = "ap-south-1b"

  tags = {
    Name = "vespera-private-b"
    Tier = "private"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.vespera.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.vespera.id
  }

  tags = {
    Name = "vespera-public-rt"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

# Private route table: deliberately has no route to the internet.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.vespera.id

  tags = {
    Name = "vespera-private-rt"
  }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

output "vespera_vpc_id" {
  description = "ID of the new Vespera network."
  value       = aws_vpc.vespera.id
}

output "vespera_public_subnet_id" {
  description = "Public subnet for internet-facing components."
  value       = aws_subnet.public_a.id
}

output "vespera_private_subnet_ids" {
  description = "Private subnets, with no route to the internet."
  value       = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}
