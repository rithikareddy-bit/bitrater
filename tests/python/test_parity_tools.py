"""Parity/cutover tools: comparison logic and the seed script's write refusal."""
import importlib.util
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import mongomock
import pytest

ROOT = Path(__file__).resolve().parents[2] / "scripts" / "parity"


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


manifest_diff = load("manifest_diff")
vmaf_compare = load("vmaf_compare")
mongo_shape_diff = load("mongo_shape_diff")
resign_dryrun_compare = load("resign_dryrun_compare")
seed_shadow = load("seed_shadow")

MASTER = """#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=720x1280,CODECS="avc1.640020,mp4a.40.2"
https://cdn.chaishots.in/ep1/26092026_120000/show_ep_1_26092026_120000_720p_h264_video.m3u8
"""


def test_manifest_diff_ignores_timestamp_and_host():
    shadow = MASTER.replace("26092026_120000", "27092026_080102").replace("cdn.chaishots.in", "storage.googleapis.com/chai-q-az-shadow-manifests")
    prod = {manifest_diff.normalise_name("ep1/26092026_120000/show_ep_1_26092026_120000_h264.m3u8"): MASTER}
    shad = {manifest_diff.normalise_name("ep1/27092026_080102/show_ep_1_27092026_080102_h264.m3u8"): shadow}
    assert manifest_diff.compare(prod, shad) == []


def test_manifest_diff_flags_bandwidth_and_missing_files():
    changed = MASTER.replace("BANDWIDTH=900000", "BANDWIDTH=950000")
    diffs = manifest_diff.compare({"a.m3u8": MASTER, "b.m4s": None}, {"a.m3u8": changed})
    assert any("only in prod: b.m4s" in d for d in diffs)
    assert any("a.m3u8: differs" in d for d in diffs)


def test_vmaf_compare_tolerances():
    ladders = {("h264", "720p"): [700, 900, 1100, 1300]}
    rows = [{"codec": "h264", "resolution": "720p", "bitrate_kbps": 900, "vmaf_score": 76.0}]
    ok = vmaf_compare.compare(rows, [dict(rows[0], vmaf_score=76.4)], {("h264", "720p"): 900}, {("h264", "720p"): 1100}, ladders)
    assert ok == []
    bad = vmaf_compare.compare(rows, [dict(rows[0], vmaf_score=77.0)], {("h264", "720p"): 700}, {("h264", "720p"): 1100}, ladders)
    assert len(bad) == 2


def test_mongo_shape_diff():
    prod = {"_id": 1, "episode_id": "e", "gcp_job_status_h264": "SUCCEEDED", "golden_recipes": {"resolutions": {"720p": {}}}}
    same = {"_id": 2, "episode_id": "e", "gcp_job_status_h264": "RUNNING", "golden_recipes": {"resolutions": {"720p": {}}}}
    assert mongo_shape_diff.diff(prod, same) == []
    assert mongo_shape_diff.diff(prod, {"_id": 3, "episode_id": "e"})


def test_resign_gate_logic():
    t0 = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)
    prod = [{"started_at": t0, "updated_count": 540, "skipped_count": 9, "errors": []}]
    good = {"started_at": t0 + timedelta(minutes=20), "target_count": 549, "canary": {"ok": True}, "errors": []}
    assert resign_dryrun_compare.evaluate([good], prod) == [(good["started_at"], [])]
    bad = dict(good, target_count=500, canary={"ok": False})
    assert len(resign_dryrun_compare.evaluate([bad], prod)[0][1]) == 2


def test_seed_refuses_non_shadow_and_copies_selected_shows():
    client = mongomock.MongoClient()
    client["master"].showcache.insert_many([
        {"_id": 1, "slug": "test-123", "episodes": [{"id": "e1"}]},
        {"_id": 2, "slug": "other", "episodes": [{"id": "e2"}]},
    ])
    client["chai_q_lab"].video_episodes.insert_many([{"_id": 10, "episode_id": "e1"}, {"_id": 11, "episode_id": "e2"}])
    with pytest.raises(seed_shadow.RefuseWrite):
        seed_shadow.shadow_db(client, "master")
    p = seed_shadow.plan(client, {"show_slugs": ["test-123"]})
    seed_shadow.apply(client, p)
    assert [d["slug"] for d in client["master_shadow"].showcache.find()] == ["test-123"]
    assert [d["episode_id"] for d in client["chai_q_lab_shadow"].video_episodes.find()] == ["e1"]
    assert client["master"].showcache.count_documents({}) == 2  # prod untouched


def test_seed_strips_prod_output_urls_but_keeps_sources():
    client = mongomock.MongoClient()
    client["master"].showcache.insert_one({"_id": 1, "slug": "s", "episodes": [
        {"id": "e1", "s3_url": "https://src/x.mp4", "signed_playback_url": "https://cdn.chaishots.in/x_combined.m3u8?t",
         "signed_playback_expires_at": 1}],
        "trailers_playback_urls": [{"_key": "k", "s3Url": "https://src/t.mp4", "gcpUrl": "https://cdn.chaishots.in/t.m3u8"}]})
    client["chai_q_lab"].video_episodes.insert_one({"_id": 2, "episode_id": "e1", "s3_url": "https://src/x.mp4",
        "h264_master_m3u8_url": "https://cdn/x", "combined_master_m3u8_url": "https://cdn/c", "lab_status_h264": "COMPLETE"})
    p = seed_shadow.plan(client, {"show_slugs": ["s"]})
    ep = p["showcache"][0]["episodes"][0]
    assert ep == {"id": "e1", "s3_url": "https://src/x.mp4"}
    assert p["showcache"][0]["trailers_playback_urls"][0] == {"_key": "k", "s3Url": "https://src/t.mp4"}
    lab = p["lab"]["video_episodes"][0]
    assert "h264_master_m3u8_url" not in lab and "combined_master_m3u8_url" not in lab
    assert lab["s3_url"] == "https://src/x.mp4" and lab["lab_status_h264"] == "COMPLETE"


def test_seed_strips_cloud_run_ids_so_shadow_never_calls_prod_aws():
    client = mongomock.MongoClient()
    client["master"].showcache.insert_one({"_id": 1, "slug": "s", "episodes": [{"id": 7}]})  # int id kept raw
    client["chai_q_lab"].video_episodes.insert_one({"_id": 2, "episode_id": 7,
        "lab_execution_arn_h264": "arn:aws:states:us-east-1:1:execution:x:y",
        "av_gcp_execution_arn_h265": "arn:aws:states:x", "gcp_job_name_h264": "projects/p/jobs/j",
        "lab_status_h264": "COMPLETE"})
    client["chai_q_lab"].audio_episodes.insert_one({"_id": 3, "episode_id": 9, "visqol": {"batch_job_id": "uuid"}})
    client["master"].podcast_showcache.insert_one({"_id": 4, "slug": "p", "episodes": [{"id": 9}]})
    p = seed_shadow.plan(client, {"show_slugs": ["s"], "podcast_slugs": ["p"]})
    lab = p["lab"]["video_episodes"][0]
    assert lab == {"_id": 2, "episode_id": 7, "lab_status_h264": "COMPLETE"}
    assert p["lab"]["audio_episodes"][0]["visqol"] == {}


def test_snapshot_playback_hash_detects_overwrite_but_not_resign():
    snapshot_prod = load("snapshot_prod")
    client = mongomock.MongoClient()
    col = client["master"].showcache
    col.insert_one({"_id": 1, "episodes": [{"id": "e", "signed_playback_url": "https://cdn/a_combined.m3u8?edge-cache-token=1"}]})
    h0 = snapshot_prod.playback_hash(client)
    col.update_one({"_id": 1}, {"$set": {"episodes.0.signed_playback_url": "https://cdn/a_combined.m3u8?edge-cache-token=2"}})
    assert snapshot_prod.playback_hash(client) == h0          # routine re-sign: unchanged
    col.update_one({"_id": 1}, {"$set": {"episodes.0.signed_playback_url": "https://storage/shadow_combined.m3u8"}})
    assert snapshot_prod.playback_hash(client) != h0          # overwrite: detected


def test_freeze_check_covers_every_live_state_machine():
    import importlib.util as u
    spec = u.spec_from_file_location("freeze_check", ROOT.parent / "cutover" / "freeze_check.py")
    fc = u.module_from_spec(spec); spec.loader.exec_module(fc)
    tf = (ROOT.parents[1] / "aws-infra").glob("*.tf")
    defined = set()
    for f in tf:
        defined |= set(re.findall(r'name\s*=\s*"((?:Chai-Q|GCP|Audio)-[A-Za-z0-9-]+)"', f.read_text()))
    assert defined and defined <= set(fc.MACHINES), defined - set(fc.MACHINES)


def test_freeze_check_require_azure_fails_closed(monkeypatch):
    import importlib.util as u
    spec = u.spec_from_file_location("freeze_check_required", ROOT.parent / "cutover" / "freeze_check.py")
    fc = u.module_from_spec(spec); spec.loader.exec_module(fc)
    for name in ("DURABLE_BASE_URL", "DURABLE_TASK_KEY", "AZURE_BATCH_ENDPOINT", "AZURE_BATCH_JOBS",
                 "AZURE_DURABLE_TARGETS", "AZURE_BATCH_TARGETS"):
        monkeypatch.delenv(name, raising=False)
    assert fc.missing_azure_config() == ["complete Durable target(s)", "complete Batch target(s)"]
    assert fc.main(["--require-azure", "--skip-azure"]) == 2


def test_freeze_check_accepts_multiple_explicit_azure_targets(monkeypatch):
    import importlib.util as u
    spec = u.spec_from_file_location("freeze_check_targets", ROOT.parent / "cutover" / "freeze_check.py")
    fc = u.module_from_spec(spec); spec.loader.exec_module(fc)
    monkeypatch.setenv("AZURE_DURABLE_TARGETS", '[{"name":"shadow","base":"https://s","key":"k"},{"name":"prod","base":"https://p","key":"k"}]')
    monkeypatch.setenv("AZURE_BATCH_TARGETS", '[{"name":"shadow","endpoint":"https://s.batch","jobs":["lab-s"]},{"name":"prod","endpoint":"https://p.batch","jobs":["lab-p"]}]')
    assert fc.missing_azure_config() == []
    durable, batch = fc.azure_targets()
    assert [t["name"] for t in durable] == ["shadow", "prod"]
    assert [t["name"] for t in batch] == ["shadow", "prod"]
