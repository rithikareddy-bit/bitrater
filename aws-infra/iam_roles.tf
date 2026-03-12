# 1. Batch Service Role (Allows Batch to manage AWS resources)
resource "aws_iam_role" "batch_service_role" {
  name = "chai-q-batch-service-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "batch.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "batch_service_attachment" {
  role       = aws_iam_role.batch_service_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"
}

# 2. Batch Instance Role (The role for the EC2 Spot instances)
resource "aws_iam_role" "batch_instance_role" {
  name = "chai-q-batch-instance-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "batch_instance_ecs" {
  role       = aws_iam_role.batch_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "batch_instance_profile" {
  name = "chai-q-batch-instance-profile"
  role = aws_iam_role.batch_instance_role.name
}

# 3. Step Function Role
resource "aws_iam_role" "step_function_role" {
  name = "chai-q-step-function-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "states.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "step_function_batch_policy" {
  name = "chai-q-sfn-batch-policy"
  role = aws_iam_role.step_function_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action   = ["batch:SubmitJob", "batch:DescribeJobs", "batch:TerminateJob"],
        Effect   = "Allow",
        Resource = "*"
      },
      {
        Action   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"],
        Effect   = "Allow",
        Resource = "*"
      },
      {
        Action   = "lambda:InvokeFunction",
        Effect   = "Allow",
        Resource = "*"
      },
      {
        # Required for Map state in DISTRIBUTED mode — creates child executions
        Action   = ["states:StartExecution", "states:DescribeExecution", "states:StopExecution"],
        Effect   = "Allow",
        Resource = "*"
      }
    ]
  })
}

# The Spot Fleet Role required for SPOT compute environments
resource "aws_iam_role" "amazon_ec2_spot_fleet_role" {
  name = "AmazonEC2SpotFleetRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "spotfleet.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "amazon_ec2_spot_fleet_role_policy" {
  role       = aws_iam_role.amazon_ec2_spot_fleet_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole"
}

# 4. GCP Pipeline Lambda Role (S3 read, Secrets Manager, CloudWatch Logs)
resource "aws_iam_role" "gcp_lambda_role" {
  name = "chai-q-gcp-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "gcp_lambda_basic" {
  role       = aws_iam_role.gcp_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "gcp_lambda_policy" {
  name = "chai-q-gcp-lambda-policy"
  role = aws_iam_role.gcp_lambda_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3ReadSource"
        Action   = ["s3:GetObject"]
        Effect   = "Allow"
        Resource = "*"
      },
      {
        Sid      = "SecretsManagerGCP"
        Action   = ["secretsmanager:GetSecretValue"]
        Effect   = "Allow"
        Resource = var.gcp_credentials_secret_arn
      }
    ]
  })
}