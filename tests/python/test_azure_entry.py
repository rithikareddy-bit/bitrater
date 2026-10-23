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


def test_missing_s3_key_is_best_effort():
    """Blob/HTTP sources and ViSQOL must still run when the S3 key secret is absent."""
    env = {"KEY_VAULT_URL": "https://kv.example", "MONGO_URI_KV_SECRET": "mongo-uri", "AWS_S3_KEY_KV_SECRET": "missing"}

    def secret_fn(v, n, t):
        if n == "missing":
            raise RuntimeError("404 SecretNotFound")
        return "mongodb://x"

    azure_entry.load_secrets(env, token_fn=lambda r: "tok", secret_fn=secret_fn)
    assert env["MONGO_URI"] == "mongodb://x" and "AWS_ACCESS_KEY_ID" not in env


def test_isolation_defaults_db_lab_from_the_batch_job():
    env = {"STAMP_DB_LAB": "chai_q_lab_shadow"}
    azure_entry.check_isolation(env)
    assert env["DB_LAB"] == "chai_q_lab_shadow"  # worker.py would otherwise fall back to prod chai_q_lab


def test_isolation_refuses_a_db_lab_the_job_does_not_allow():
    import pytest
    with pytest.raises(SystemExit, match="ISOLATION_FAILED"):
        azure_entry.check_isolation({"STAMP_DB_LAB": "chai_q_lab_shadow", "DB_LAB": "chai_q_lab"})
    azure_entry.check_isolation({"DB_LAB": "chai_q_lab"})  # outside Azure Batch: no-op


class _Child:
    def __init__(self, code):
        self.code, self.signals = code, []

    def wait(self):
        return self.code

    def send_signal(self, sig):
        self.signals.append(sig)


def test_run_worker_passes_exit_code_and_cleans_the_task_dir(tmp_path):
    (tmp_path / "source.mp4").write_bytes(b"x" * 10)
    (tmp_path / "variant.mp4").write_bytes(b"y")
    (tmp_path / "tmpdir").mkdir(); (tmp_path / "tmpdir" / "ref.wav").write_bytes(b"z")
    image_cfg = tmp_path.parent / f"{tmp_path.name}-cfg"; image_cfg.mkdir()
    (tmp_path / "configs").symlink_to(image_cfg)
    env = {"AZ_BATCH_TASK_WORKING_DIR": str(tmp_path)}
    seen = []
    code = azure_entry.run_worker(["--x"], str(tmp_path), env,
                                  popen=lambda args, env: seen.append(args) or _Child(3))
    assert code == 3 and seen[0][-2:] == ["/var/task/worker.py", "--x"]
    assert list(tmp_path.iterdir()) == [] and image_cfg.is_dir()  # link removed, target untouched


def test_run_worker_reports_signal_like_a_shell_and_never_cleans_outside_batch(tmp_path):
    (tmp_path / "keep.txt").write_text("k")
    code = azure_entry.run_worker([], str(tmp_path), {}, popen=lambda args, env: _Child(-15))
    assert code == 143 and (tmp_path / "keep.txt").exists()
