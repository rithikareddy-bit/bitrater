terraform {
  backend "s3" {
    bucket         = "chai-q-terraform-state-107647021172"
    key            = "video-q-lab/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "chai-q-terraform-locks"
  }
}
