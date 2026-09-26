"""Fetch a secret from AWS Secrets Manager or Azure Key Vault by reference.

References keep the existing env var names (GCP_CREDENTIALS_SECRET_ARN,
SIGNING_KEY_SECRET_ID, ...):
  kv:<secret-name>   -> Azure Key Vault at $KEY_VAULT_URL (managed identity)
  anything else      -> Secrets Manager, exactly the call the Lambdas made before

No caching here: callers keep their own caching behaviour unchanged.
Named secret_store (not secrets) so it never shadows the stdlib `secrets` module.
"""
import json
import os

KV_PREFIX = "kv:"

_kv_client = None


def _keyvault_client():
    global _kv_client
    if _kv_client is None:
        # Imported lazily: the AWS Lambda layer does not ship the Azure SDK.
        from azure.identity import DefaultAzureCredential
        from azure.keyvault.secrets import SecretClient

        _kv_client = SecretClient(vault_url=os.environ["KEY_VAULT_URL"], credential=DefaultAzureCredential())
    return _kv_client


def get_string(ref: str) -> str:
    if ref.startswith(KV_PREFIX):
        return _keyvault_client().get_secret(ref[len(KV_PREFIX):]).value
    import boto3

    return boto3.client("secretsmanager").get_secret_value(SecretId=ref)["SecretString"]


def get_json(ref: str):
    return json.loads(get_string(ref))
