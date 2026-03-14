resource "aws_batch_job_definition" "chai_q_worker_def" {
  name = "chai-q-worker"
  type = "container"

  # This tells Batch to use the latest image pushed to ECR
  container_properties = jsonencode({
    image = "${aws_ecr_repository.chai_q_worker.repository_url}:latest"

    # We pass the Mongo URI here so the worker can write results
    environment = [
      {
        name  = "MONGO_URI"
        value = var.mongo_uri
      }
    ]

    # These are the permissions the container itself has (to read from S3)
    jobRoleArn = aws_iam_role.batch_instance_role.arn
    
    # Crucial for FFmpeg/VMAF: Use enough resources to avoid OOM (Out of Memory)
    resourceRequirements = [
      {
        value = "4"
        type  = "VCPU"
      },
      {
        value = "7168"
        type  = "MEMORY"
      }
    ]
  })

  # This ensures we don't try to create the job def until the image is pushed
  depends_on = [null_resource.docker_push]
}