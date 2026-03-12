provider "aws" {
  region = "us-east-1" 
}

# --- Networking ---
resource "aws_vpc" "chai_q_vpc" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "chai_q_subnet" {
  vpc_id     = aws_vpc.chai_q_vpc.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_security_group" "batch_sg" {
  name   = "chai-q-batch-sg"
  vpc_id = aws_vpc.chai_q_vpc.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- S3 ---
resource "aws_s3_bucket" "raw_input" {
  bucket = "chai-q-raw-input-lab"
}

# --- AWS Batch Compute Environment ---
resource "aws_batch_compute_environment" "spot_env" {
  # In v6.x, this is often just 'compute_environment_name' 
  # but ensure it is NOT inside 'compute_resources'
  name = "chai-q-spot-env"
  
  compute_resources {
    instance_role      = aws_iam_instance_profile.batch_instance_profile.arn
    instance_type      = ["c5.xlarge"]
    max_vcpus          = 256
    min_vcpus          = 0
    security_group_ids = [aws_security_group.batch_sg.id]
    subnets            = [aws_subnet.chai_q_subnet.id]
    type               = "SPOT"
    spot_iam_fleet_role = aws_iam_role.amazon_ec2_spot_fleet_role.arn

  }
  service_role = aws_iam_role.batch_service_role.arn
  type         = "MANAGED"
}

# --- AWS Batch Job Queue ---
resource "aws_batch_job_queue" "chai_q_queue" {
  name     = "chai-q-queue"
  priority = 1
  state    = "ENABLED"

  # Updated syntax for v6.x
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.spot_env.arn
  }
}

# --- Step Function ---
resource "aws_sfn_state_machine" "research_orchestrator" {
  name     = "Chai-Q-Orchestrator"
  role_arn = aws_iam_role.step_function_role.arn

  # templatefile injects real ARNs into the JSON definition at apply time.
  # JSONPath $$.Execution.Input references are passed as variables to avoid
  # collision with Terraform's own ${ } template syntax.
  definition = templatefile("../orchestrator/step_function_def.json", {
    batch_job_queue_arn      = aws_batch_job_queue.chai_q_queue.arn
    batch_job_definition_arn = aws_batch_job_definition.chai_q_worker_def.arn
    aggregator_lambda_arn    = aws_lambda_function.aggregator.arn
    ctx_bitrate              = "$.bitrate"
    ctx_codec                = "$.codec"
    ctx_resolution           = "$.resolution"
    ctx_s3_url               = "$$.Execution.Input.s3_url"
    ctx_episode_id           = "$$.Execution.Input.episode_id"
  })
}