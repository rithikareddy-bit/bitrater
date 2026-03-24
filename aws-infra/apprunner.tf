# --- ECR Repository for dashboard image ---

resource "aws_ecr_repository" "dashboard" {
  name                 = "chai-q-dashboard"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

# Build and push initial dashboard image so App Runner has something to deploy
resource "null_resource" "dashboard_docker_push" {
  triggers = {
    dockerfile_hash  = filemd5("../dashboard/Dockerfile")
    next_config_hash = filemd5("../dashboard/next.config.js")
    package_hash     = filemd5("../dashboard/package.json")
  }

  provisioner "local-exec" {
    command = <<EOF
      aws ecr get-login-password --region us-east-1 | \
        docker login --username AWS --password-stdin ${aws_ecr_repository.dashboard.repository_url}

      cd ..
      docker build --platform linux/amd64 -f dashboard/Dockerfile -t chai-q-dashboard .

      docker tag chai-q-dashboard:latest ${aws_ecr_repository.dashboard.repository_url}:latest
      docker push ${aws_ecr_repository.dashboard.repository_url}:latest
    EOF
  }

  depends_on = [aws_ecr_repository.dashboard]
}

# --- IAM: ECR access role (App Runner build-time pulls) ---

resource "aws_iam_role" "apprunner_ecr_access" {
  name = "chai-q-apprunner-ecr-access"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "build.apprunner.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr_policy" {
  role       = aws_iam_role.apprunner_ecr_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# --- IAM: Instance role (runtime — API routes call SFN + Batch) ---

resource "aws_iam_role" "apprunner_instance" {
  name = "chai-q-apprunner-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "tasks.apprunner.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "apprunner_runtime_policy" {
  name = "chai-q-apprunner-runtime"
  role = aws_iam_role.apprunner_instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ManageStepFunction"
        Effect   = "Allow"
        Action   = [
          "states:StartExecution",
          "states:StopExecution",
        ]
        Resource = [
          aws_sfn_state_machine.research_orchestrator.arn,
          aws_sfn_state_machine.research_orchestrator_h264.arn,
          aws_sfn_state_machine.research_orchestrator_h265.arn,
          aws_sfn_state_machine.gcp_orchestrator.arn,
          "arn:aws:states:us-east-1:107647021172:execution:Chai-Q-Orchestrator:*",
          "arn:aws:states:us-east-1:107647021172:execution:Chai-Q-Orchestrator-H264:*",
          "arn:aws:states:us-east-1:107647021172:execution:Chai-Q-Orchestrator-H265:*",
          "arn:aws:states:us-east-1:107647021172:execution:GCP-Orchestrator:*",
        ]
      },
      {
        Sid      = "DescribeLabExecution"
        Effect   = "Allow"
        Action   = "states:DescribeExecution"
        Resource = "*"
      },
      {
        Sid      = "ListBatchJobs"
        Effect   = "Allow"
        Action   = "batch:ListJobs"
        Resource = "*"
      },
      {
        Sid      = "InvokeCombinedMasterLambda"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.gcp_create_combined_master.arn
      }
    ]
  })
}

# --- App Runner Service ---

resource "aws_apprunner_service" "dashboard" {
  service_name = "chai-q-dashboard"

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr_access.arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.dashboard.repository_url}:latest"
      image_repository_type = "ECR"

      image_configuration {
        port = "3000"
        runtime_environment_variables = {
          MONGO_URI               = var.mongo_uri
          SFN_ARN                 = aws_sfn_state_machine.research_orchestrator.arn
          SFN_ARN_H264            = aws_sfn_state_machine.research_orchestrator_h264.arn
          SFN_ARN_H265            = aws_sfn_state_machine.research_orchestrator_h265.arn
          GCP_SFN_ARN             = aws_sfn_state_machine.gcp_orchestrator.arn
          BATCH_JOB_QUEUE         = aws_batch_job_queue.chai_q_queue.name
          CREATE_COMBINED_MASTER_LAMBDA_ARN = aws_lambda_function.gcp_create_combined_master.arn
          NEXT_TELEMETRY_DISABLED           = "1"
          # AWS_REGION is set automatically by App Runner
        }
      }
    }

    # Redeploy automatically when a new image is pushed to ECR
    auto_deployments_enabled = true
  }

  instance_configuration {
    instance_role_arn = aws_iam_role.apprunner_instance.arn
    cpu               = "1024" # 1 vCPU
    memory            = "2048" # 2 GB
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  depends_on = [null_resource.dashboard_docker_push]
}
