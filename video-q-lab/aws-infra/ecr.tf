# 1. Create the ECR Repository
resource "aws_ecr_repository" "chai_q_worker" {
  name                 = "chai-q-worker"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # Good for lab environments
}

# 2. Automated Build & Push Logic
resource "null_resource" "docker_push" {
  # This triggers the build only when the Dockerfile or worker script changes
  triggers = {
    worker_hash = filemd5("../research-worker/worker.py")
    docker_hash = filemd5("../research-worker/Dockerfile")
    h265_hash   = filemd5("../configs/h265_heavy.json")
    h264_hash   = filemd5("../configs/h264_heavy.json")
  }

  provisioner "local-exec" {
    command = <<EOF
      # 1. Authenticate Docker to ECR
      aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${aws_ecr_repository.chai_q_worker.repository_url}

      # 2. Build for the correct platform (Batch EC2s are usually x86_64)
      # Context is the project root so configs/ is available to the Dockerfile
      cd ..
      docker build --platform linux/amd64 -t chai-q-worker -f research-worker/Dockerfile .

      # 3. Tag and Push
      docker tag chai-q-worker:latest ${aws_ecr_repository.chai_q_worker.repository_url}:latest
      docker push ${aws_ecr_repository.chai_q_worker.repository_url}:latest
    EOF
  }

  depends_on = [aws_ecr_repository.chai_q_worker]
}