# --- IAM Role for Amplify (build + SSR runtime) ---

resource "aws_iam_role" "amplify_service_role" {
  name = "chai-q-amplify-service-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "amplify.amazonaws.com" }
    }]
  })
}

# Managed policy covers Amplify build/deploy operations
resource "aws_iam_role_policy_attachment" "amplify_managed" {
  role       = aws_iam_role.amplify_service_role.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess-Amplify"
}

# Inline policy grants SSR Lambda functions access to SFN + Batch at runtime
resource "aws_iam_role_policy" "amplify_runtime_policy" {
  name = "chai-q-amplify-runtime"
  role = aws_iam_role.amplify_service_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartStepFunction"
        Effect   = "Allow"
        Action   = "states:StartExecution"
        Resource = aws_sfn_state_machine.research_orchestrator.arn
      },
      {
        Sid    = "ListBatchJobs"
        Effect = "Allow"
        Action = "batch:ListJobs"
        Resource = "*"
      }
    ]
  })
}

# --- Amplify App ---

resource "aws_amplify_app" "dashboard" {
  name                 = "chai-q-lab-dashboard"
  repository           = var.github_repository
  oauth_token          = var.github_token
  iam_service_role_arn = aws_iam_role.amplify_service_role.arn

  # Platform must be WEB_COMPUTE to enable Next.js SSR (API routes run as Lambda)
  platform = "WEB_COMPUTE"

  # Build spec is read from the repo's amplify.yml (appRoot: dashboard handles monorepo)
  build_spec = file("../dashboard/amplify.yml")

  environment_variables = {
    MONGO_URI               = var.mongo_uri
    SFN_ARN                 = aws_sfn_state_machine.research_orchestrator.arn
    BATCH_JOB_QUEUE         = aws_batch_job_queue.chai_q_queue.name
    NEXT_TELEMETRY_DISABLED = "1"
    # AWS_REGION is reserved — the SSR Lambda runtime sets it automatically
  }
}

# --- Branch: main ---

resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.dashboard.id
  branch_name = "main"
  framework   = "Next.js - SSR"
  stage       = "PRODUCTION"

  enable_auto_build = true

  environment_variables = {
    NODE_ENV = "production"
  }
}
