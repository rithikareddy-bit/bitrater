"""workers/azure_entry.py: Key Vault secrets -> the env vars worker.py already reads."""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("azure_entry", Path(__file__).resolve().parents[2] / "workers" / "azure_entry.py")
azure_entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(azure_entry)


def test_loads_mongo_and_s3_key_from_key_vault():
    env = {"KEY_VAULT_URL": "https://kv.example", "MONGO_URI_KV_SECRET": "mongo-uri", "AWS_S3_KEY_KV_SECRET": "s3-ro"}
    secrets = {"mongo-uri": "mongodb://x", "s3-ro": json.dumps({"access_key_id": "AK", "secret_access_key": "SK"})}
    seen = []
    azure_entry.load_secrets(env, token_fn=lambda r: seen.append(r) or "tok",
                             secret_fn=lambda v, n, t: secrets[n])
    assert seen == ["https://vault.azure.net"]
    assert env["MONGO_URI"] == "mongodb://x"
    assert (env["AWS_ACCESS_KEY_ID"], env["AWS_SECRET_ACCESS_KEY"]) == ("AK", "SK")


def test_no_vault_is_a_noop():
    env = {"MONGO_URI": "mongodb://local"}
    azure_entry.load_secrets(env, token_fn=lambda r: (_ for _ in ()).throw(AssertionError("no IMDS")))
    assert env == {"MONGO_URI": "mongodb://local"}


def test_prepare_workdir_moves_to_task_dir_and_links_configs(tmp_path, monkeypatch):
    image = tmp_path / "image"; (image / "configs").mkdir(parents=True)
    (image / "configs" / "h264_heavy.json").write_text("{}")
    task = tmp_path / "task"; task.mkdir()
    monkeypatch.chdir(tmp_path)
    assert azure_entry.prepare_workdir({"AZ_BATCH_TASK_WORKING_DIR": str(task)}, str(image)) == str(task)
    assert (task / "configs" / "h264_heavy.json").read_text() == "{}"
    import os
    assert os.getcwd() == str(task)


def test_prepare_workdir_noop_outside_batch(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert azure_entry.prepare_workdir({}, "/nonexistent") == str(tmp_path)
