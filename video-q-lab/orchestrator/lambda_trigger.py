import boto3
import json
import os
import uuid
from datetime import datetime, timezone

sfn = boto3.client('stepfunctions')

def handler(event, context):
    # Extract Bucket and Key from S3 Event
    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']
    s3_url = f"s3://{bucket}/{key}"
    
    # Generate a unique Episode ID if not provided in metadata
    episode_id = f"chai_{uuid.uuid4().hex[:8]}"
    
    # Start Step Function Execution
    response = sfn.start_execution(
        stateMachineArn=os.environ['STATE_MACHINE_ARN'],
        input=json.dumps({
            "s3_url": s3_url,
            "episode_id": episode_id,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
    )
    
    return {
        'statusCode': 200,
        'body': json.dumps(f"Started research for {episode_id}")
    }