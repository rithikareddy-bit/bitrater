# --- Lambda IAM Execution Role ---
resource "aws_iam_role" "lambda_exec_role" {
  name = "chai-q-lambda-exec-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# s3_trigger needs permission to start the Step Function
resource "aws_iam_role_policy" "lambda_sfn_start" {
  name = "chai-q-lambda-sfn-start"
  role = aws_iam_role.lambda_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "states:StartExecution"
      Effect   = "Allow"
      Resource = aws_sfn_state_machine.research_orchestrator.arn
    }]
  })
}

# --- pymongo Lambda Layer (aggregator depends on it, not in Lambda runtime) ---
# Built inside Docker to produce Linux x86_64 binaries compatible with Lambda.
resource "null_resource" "pymongo_layer_build" {
  triggers = {
    version = "pymongo-srv-4.6.1-linux-v2"
  }
  provisioner "local-exec" {
    command = <<-EOT
      rm -rf "${path.module}/.pymongo-layer"
      mkdir -p "${path.module}/.pymongo-layer/python"
      docker run --rm --platform linux/amd64 \
        --entrypoint pip \
        -v "${path.module}/.pymongo-layer/python:/out" \
        public.ecr.aws/lambda/python:3.11 \
        install "pymongo[srv]==4.6.1" -t /out --quiet
    EOT
  }
}

data "archive_file" "pymongo_layer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/.pymongo-layer"
  output_path = "${path.module}/.pymongo-layer.zip"
  depends_on  = [null_resource.pymongo_layer_build]
}

resource "aws_lambda_layer_version" "pymongo" {
  layer_name          = "chai-q-pymongo"
  filename            = data.archive_file.pymongo_layer_zip.output_path
  source_code_hash    = data.archive_file.pymongo_layer_zip.output_base64sha256
  compatible_runtimes = ["python3.11"]
}

# --- Package Lambda source files ---
data "archive_file" "trigger_zip" {
  type        = "zip"
  source_file = "../orchestrator/lambda_trigger.py"
  output_path = "/tmp/chai-q-trigger.zip"
}

data "archive_file" "aggregator_zip" {
  type        = "zip"
  source_file = "../orchestrator/aggregator.py"
  output_path = "/tmp/chai-q-aggregator.zip"
}

data "archive_file" "mark_lab_failed_zip" {
  type        = "zip"
  source_file = "../orchestrator/mark_lab_failed.py"
  output_path = "/tmp/chai-q-mark-lab-failed.zip"
}

# --- S3 Trigger Lambda ---
resource "aws_lambda_function" "s3_trigger" {
  filename         = data.archive_file.trigger_zip.output_path
  source_code_hash = data.archive_file.trigger_zip.output_base64sha256
  function_name    = "chai-q-s3-trigger"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "lambda_trigger.handler"
  runtime          = "python3.11"
  timeout          = 30

  environment {
    variables = {
      STATE_MACHINE_ARN = aws_sfn_state_machine.research_orchestrator.arn
    }
  }
}

# Allow S3 to invoke the trigger Lambda
resource "aws_lambda_permission" "allow_s3_invoke" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.s3_trigger.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.raw_input.arn
}

# Wire S3 upload event -> Lambda trigger
resource "aws_s3_bucket_notification" "upload_trigger" {
  bucket = aws_s3_bucket.raw_input.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.s3_trigger.arn
    events              = ["s3:ObjectCreated:*"]
  }

  depends_on = [aws_lambda_permission.allow_s3_invoke]
}

# --- Aggregator Lambda ---
resource "aws_lambda_function" "aggregator" {
  filename         = data.archive_file.aggregator_zip.output_path
  source_code_hash = data.archive_file.aggregator_zip.output_base64sha256
  function_name    = "chai-q-aggregator"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "aggregator.handler"
  runtime          = "python3.11"
  timeout          = 60
  layers           = [aws_lambda_layer_version.pymongo.arn]

  environment {
    variables = {
      MONGO_URI = var.mongo_uri
    }
  }
}

# --- Mark lab failed (Step Function Catch) ---
resource "aws_lambda_function" "mark_lab_failed" {
  filename         = data.archive_file.mark_lab_failed_zip.output_path
  source_code_hash = data.archive_file.mark_lab_failed_zip.output_base64sha256
  function_name    = "chai-q-mark-lab-failed"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "mark_lab_failed.handler"
  runtime          = "python3.11"
  timeout          = 30
  layers           = [aws_lambda_layer_version.pymongo.arn]

  environment {
    variables = {
      MONGO_URI = var.mongo_uri
    }
  }
}

# =============================================================================
# GCP Pipeline Lambdas + GCP-Orchestrator Step Function
# =============================================================================

# --- GCP Lambda Layer (google-cloud deps + pymongo + requests) ---
# Built inside Docker to produce Linux x86_64 binaries compatible with Lambda.
resource "null_resource" "gcp_layer_build" {
  triggers = {
    version = "gcp-transcoder-0.3-linux-v2"
  }
  provisioner "local-exec" {
    command = <<-EOT
      rm -rf "${path.module}/.gcp-layer"
      mkdir -p "${path.module}/.gcp-layer/python"
      docker run --rm --platform linux/amd64 \
        --entrypoint pip \
        -v "${path.module}/.gcp-layer/python:/out" \
        public.ecr.aws/lambda/python:3.11 \
        install \
          "google-cloud-video-transcoder>=1.0.0" \
          "google-cloud-storage>=2.0.0" \
          "pymongo[srv]==4.6.1" \
          "requests>=2.31.0" \
          -t /out --quiet
    EOT
  }
}

data "archive_file" "gcp_layer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/.gcp-layer"
  output_path = "${path.module}/.gcp-layer.zip"
  depends_on  = [null_resource.gcp_layer_build]
}

resource "aws_lambda_layer_version" "gcp_deps" {
  layer_name          = "chai-q-gcp-deps"
  filename            = data.archive_file.gcp_layer_zip.output_path
  source_code_hash    = data.archive_file.gcp_layer_zip.output_base64sha256
  compatible_runtimes = ["python3.11"]
}

# --- Package GCP Lambda source files ---
data "archive_file" "gcp_copy_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_copy_s3_to_gcs.py"
  output_path = "/tmp/chai-q-gcp-copy.zip"
}

data "archive_file" "gcp_transcoder_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_transcoder.py"
  output_path = "/tmp/chai-q-gcp-transcoder.zip"
}

data "archive_file" "gcp_check_status_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_check_status.py"
  output_path = "/tmp/chai-q-gcp-check-status.zip"
}

data "archive_file" "gcp_finalize_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_finalize_hls.py"
  output_path = "/tmp/chai-q-gcp-finalize.zip"
}

locals {
  gcp_lambda_env = {
    MONGO_URI                  = var.mongo_uri
    GCP_PROJECT                = var.gcp_project
    GCP_LOCATION               = var.gcp_location
    GCS_INPUT_BUCKET           = var.gcs_input_bucket
    GCS_OUTPUT_BUCKET          = var.gcs_output_bucket
    GCP_CREDENTIALS_SECRET_ARN = var.gcp_credentials_secret_arn
  }
}

# --- CopySourceToGCS Lambda ---
resource "aws_lambda_function" "gcp_copy" {
  filename         = data.archive_file.gcp_copy_zip.output_path
  source_code_hash = data.archive_file.gcp_copy_zip.output_base64sha256
  function_name    = "chai-q-gcp-copy-s3-to-gcs"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_copy_s3_to_gcs.handler"
  runtime          = "python3.11"
  timeout          = 900
  memory_size      = 512
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- SubmitGCPJob Lambda ---
resource "aws_lambda_function" "gcp_transcoder" {
  filename         = data.archive_file.gcp_transcoder_zip.output_path
  source_code_hash = data.archive_file.gcp_transcoder_zip.output_base64sha256
  function_name    = "chai-q-gcp-transcoder"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_transcoder.handler"
  runtime          = "python3.11"
  timeout          = 120
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- CheckJobStatus Lambda ---
resource "aws_lambda_function" "gcp_check_status" {
  filename         = data.archive_file.gcp_check_status_zip.output_path
  source_code_hash = data.archive_file.gcp_check_status_zip.output_base64sha256
  function_name    = "chai-q-gcp-check-status"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_check_status.handler"
  runtime          = "python3.11"
  timeout          = 60
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- FinalizeHLS Lambda ---
resource "aws_lambda_function" "gcp_finalize" {
  filename         = data.archive_file.gcp_finalize_zip.output_path
  source_code_hash = data.archive_file.gcp_finalize_zip.output_base64sha256
  function_name    = "chai-q-gcp-finalize-hls"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_finalize_hls.handler"
  runtime          = "python3.11"
  timeout          = 300
  memory_size      = 256
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- GCP-Orchestrator Step Function ---
resource "aws_sfn_state_machine" "gcp_orchestrator" {
  name     = "GCP-Orchestrator"
  role_arn = aws_iam_role.step_function_role.arn

  definition = templatefile("../orchestrator/gcp_step_function_def.json", {
    gcp_copy_lambda_arn         = aws_lambda_function.gcp_copy.arn
    gcp_transcoder_lambda_arn   = aws_lambda_function.gcp_transcoder.arn
    gcp_check_status_lambda_arn = aws_lambda_function.gcp_check_status.arn
    gcp_finalize_lambda_arn     = aws_lambda_function.gcp_finalize.arn
  })
}
