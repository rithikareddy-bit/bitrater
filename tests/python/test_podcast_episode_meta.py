"""Finalize/combine resolve podcast episodes (Audio-Video page) from
podcast_showcache when the id is not in showcache."""
import pytest

import gcp_create_combined_master as combined
import gcp_finalize_hls as finalize


class _Coll:
    def __init__(self, shows):
        self.shows = shows

    def find_one(self, query, projection=None):
        ep_id = query["episodes.id"]
        for show in self.shows:
            eps = [e for e in show["episodes"] if e["id"] == ep_id]
            if eps:
                return {"slug": show["slug"], "episodes": eps[:1]}
        return None


class _Db(dict):
    def __getitem__(self, name):
        return self.get(name) or _Coll([])


class _Client:
    def __init__(self, master):
        self.master = master

    def __getitem__(self, _name):
        return self.master


SHOWCACHE = [{"slug": "drama", "episodes": [{"id": "sc-1", "episode_number": 3, "slug": "drama-3"}]}]
PODCAST = [{"slug": "girl-talks-podcast", "episodes": [{"id": "pc-9", "episode_number": 9, "duration": 2971}]}]


def _client():
    return _Client(_Db(showcache=_Coll(SHOWCACHE), podcast_showcache=_Coll(PODCAST)))


class _LabDb:
    def __init__(self, client):
        self.client = client


def test_finalize_showcache_episode_unchanged():
    slug, key, show, num, _ = finalize._get_episode_meta(_LabDb(_client()), "sc-1")
    assert (slug, key, show, num) == ("drama-3", "drama/drama-3", "drama", 3)


def test_finalize_falls_back_to_podcast_showcache():
    slug, key, show, num, dur = finalize._get_episode_meta(_LabDb(_client()), "pc-9")
    assert (slug, key, show, num, dur) == ("pc-9", "girl-talks-podcast/pc-9", "girl-talks-podcast", 9, 2971)


def test_finalize_unknown_episode_still_raises():
    with pytest.raises(ValueError, match="not found"):
        finalize._get_episode_meta(_LabDb(_client()), "missing")


def test_combined_meta_both_collections():
    assert combined._get_episode_meta(_client(), "sc-1") == ("drama", 3)
    assert combined._get_episode_meta(_client(), "pc-9") == ("girl-talks-podcast", 9)
    assert combined._get_episode_meta(_client(), "missing") == ("unknown", 0)
