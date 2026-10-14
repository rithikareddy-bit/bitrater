"""H.264 and H.265 runs of one episode execute in parallel. The copy step must
keep each codec's GCS objects separate, and the transcoder must write the
Audio-Video (`av_`) status fields for AV runs."""
import os
from types import SimpleNamespace

import gcp_copy_s3_to_gcs as copy_mod
import gcp_transcoder as tc


# --- fake GCS ---------------------------------------------------------------
class _Blob:
    def __init__(self, bucket, name):
        self.bucket, self.name, self.size = bucket, name, None

    def upload_from_file(self, stream, content_type=None):
        self.bucket.objects[self.name] = stream.read()

    def compose(self, sources):
        self.bucket.objects[self.name] = b"".join(self.bucket.objects[s.name] for s in sources)

    def reload(self):
        self.size = len(self.bucket.objects[self.name])

    def delete(self):
        self.bucket.objects.pop(self.name, None)


class _Bucket:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})

    def blob(self, name):
        return _Blob(self, name)

    def list_blobs(self, prefix=""):
        return [_Blob(self, n) for n in list(self.objects) if n.startswith(prefix)]

    def delete_blobs(self, blobs):
        for b in blobs:
            self.objects.pop(b.name, None)


class _Source:
    label = "test"

    def __init__(self, data):
        self.data = data

    def content_length(self):
        return len(self.data)

    def open_stream(self):
        import io
        return io.BytesIO(self.data)


def _run_copy(monkeypatch, codec, data, buckets):
    monkeypatch.setenv("GCS_INPUT_BUCKET", "in")
    monkeypatch.setenv("GCS_OUTPUT_BUCKET", "out")
    monkeypatch.setenv("GCP_PROJECT", "p")
    monkeypatch.setattr(copy_mod, "_get_gcp_credentials", lambda: None)
    monkeypatch.setattr(copy_mod, "_parse_source_url", lambda url: _Source(data))
    monkeypatch.setattr(copy_mod.gcs, "Client", lambda **kw: SimpleNamespace(bucket=lambda n: buckets[n]))
    monkeypatch.setattr(copy_mod, "_upload_one_part",
                        lambda src, bucket, name, start, end: bucket.objects.__setitem__(name, src.data[start:end + 1]))
    event = {"episode_id": "ep", "s3_url": "https://x/y.mp4", "golden_recipes": {}, "source_fps": 25}
    if codec:
        event["codec"] = codec
    return copy_mod.handler(event, None)


def test_copy_is_scoped_to_codec(monkeypatch):
    monkeypatch.setattr(copy_mod, "PART_SIZE", 4)
    buckets = {
        # h264 already transcoding: its output and parts must survive the h265 copy.
        "out": _Bucket({"ep/h264_master.m3u8": b"x", "ep/720p_h264_video/seg.m4s": b"x",
                        "ep/h265_master.m3u8": b"stale"}),
        "in": _Bucket({"ep/.copyparts/h264/part_00000": b"keep"}),
    }
    res = _run_copy(monkeypatch, "h265", b"0123456789", buckets)

    assert res["gcs_input_uri"] == "gs://in/ep/source_h265.mp4"
    assert buckets["in"].objects["ep/source_h265.mp4"] == b"0123456789"
    assert "ep/.copyparts/h264/part_00000" in buckets["in"].objects   # other codec untouched
    assert not [n for n in buckets["in"].objects if n.startswith("ep/.copyparts/h265/")]  # own parts cleaned
    assert set(buckets["out"].objects) == {"ep/h264_master.m3u8", "ep/720p_h264_video/seg.m4s"}


def test_copy_without_codec_keeps_legacy_names(monkeypatch):
    buckets = {"out": _Bucket({"ep/a": b"x"}), "in": _Bucket()}
    res = _run_copy(monkeypatch, None, b"abc", buckets)
    assert res["gcs_input_uri"] == "gs://in/ep/source.mp4"
    assert buckets["out"].objects == {}


# --- transcoder status fields ------------------------------------------------
def _run_transcoder(monkeypatch, golden_recipes):
    writes = []
    monkeypatch.setenv("MONGO_URI", "mongodb://test")
    monkeypatch.setenv("GCP_PROJECT", "p")
    monkeypatch.setenv("GCS_OUTPUT_BUCKET", "out")
    monkeypatch.setattr(tc, "_build_job_config", lambda *a, **k: None)
    monkeypatch.setattr(tc, "_get_gcp_credentials", lambda: None)
    monkeypatch.setattr(tc.types, "Job", lambda config=None: None)
    monkeypatch.setattr(tc.transcoder_v1, "TranscoderServiceClient",
                        lambda credentials=None: SimpleNamespace(create_job=lambda parent, job: SimpleNamespace(name="jobs/1")))
    coll = SimpleNamespace(update_one=lambda q, u: writes.append(u["$set"]))
    monkeypatch.setattr(tc.pymongo, "MongoClient",
                        lambda uri: {k: SimpleNamespace(video_episodes=coll) for k in ("chai_q_lab", tc_db())})
    tc.handler({"episode_id": "ep", "gcs_input_uri": "gs://in/ep/source_h264.mp4", "golden_recipes": golden_recipes,
                "codec": "h264", "source_fps": 25}, None)
    return writes[0]


def tc_db():
    rc = getattr(tc, "runtime_config", None)
    return getattr(rc, "DB_LAB", "chai_q_lab")


def test_transcoder_av_run_writes_av_fields(monkeypatch):
    w = _run_transcoder(monkeypatch, {"resolutions": {}, "av_run": True})
    assert w == {"av_gcp_job_status_h264": "RUNNING", "av_gcp_job_name_h264": "jobs/1"}


def test_transcoder_classic_run_unchanged(monkeypatch):
    w = _run_transcoder(monkeypatch, {"resolutions": {}})
    assert w == {"gcp_job_status_h264": "RUNNING", "gcp_job_name_h264": "jobs/1"}
