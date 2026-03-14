import argparse
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

SYNC_ENDPOINT = "https://media-api.chaishots.in/sync-subtitles"


def manifest_path_for(out_dir: Path) -> Path:
	return out_dir / "transfer_manifest.json"


def load_manifest(out_dir: Path) -> Dict[str, Any]:
	path = manifest_path_for(out_dir)
	if not path.exists():
		raise FileNotFoundError(f"Manifest not found: {path}")
	import json
	with open(path, "r", encoding="utf-8") as f:
		return json.load(f)


def save_manifest(out_dir: Path, data: Dict[str, Any]) -> None:
	import json
	path = manifest_path_for(out_dir)
	with open(path, "w", encoding="utf-8") as f:
		json.dump(data, f, indent=2, ensure_ascii=False)


def derive_subtitle_folder(ep: Dict[str, Any]) -> str:
	file_path = Path(ep.get("file", ""))
	# Prefer folder recorded by Step 4 upload if present
	episode_stem = file_path.stem
	subs_upload = ep.get("subtitles_upload") or {}
	# 1) Exact folder returned by API in Step 4 (most reliable)
	api_folder = subs_upload.get("subtitle_folder") or ""
	if api_folder:
		return api_folder
	# 2) Construct using first language if available (matches current server convention)
	languages = subs_upload.get("languages") or []
	first_lang = languages[0] if languages else ""
	if first_lang:
		return f"{episode_stem}_{first_lang}"
	# 3) Fallback to plain episode stem
	return episode_stem


def derive_hls_folder(ep: Dict[str, Any]) -> Optional[str]:
	"""
	Prefer folder from upload.hls_720 or response.expected_hls_output in manifest.
	Return value like: hls/<folder_name>
	"""
	upload = ep.get("upload") or {}
	hls_720 = upload.get("hls_720") or ""
	candidate = hls_720
	if not candidate:
		response = upload.get("response") or {}
		candidate = response.get("expected_hls_output") or ""
	if not candidate:
		# Older manifests may have expected_hls_output at top level per episode
		candidate = ep.get("expected_hls_output") or ""
	if not candidate:
		return None
	try:
		p = urlparse(candidate)
		# Example path: /hls/<folder>/<file.m3u8>
		path = p.path.lstrip("/")
		folder = os.path.dirname(path)
		return folder if folder else None
	except Exception:
		return None


def safe_json(resp: requests.Response) -> Any:
	try:
		return resp.json()
	except Exception:
		return {"status_code": resp.status_code, "text": resp.text[:1000]}


def call_sync(subtitle_folder: str, hls_folder: str) -> Tuple[int, Dict[str, Any]]:
	form = {
		"subtitle_folder": subtitle_folder,
		"hls_folder": hls_folder,
	}
	print(f"[sync] request: {form}")
	resp = requests.post(SYNC_ENDPOINT, data=form, timeout=300)
	status = resp.status_code
	preview = resp.text[:1000]
	print(f"[sync] response: status={status} body={preview}")
	try:
		resp.raise_for_status()
	except Exception:
		pass
	return status, {"request": form, "response": safe_json(resp)}


def step5_sync_cache(slug: str, out_dir: Optional[Path], episode_index: Optional[int] = None, episode_number: Optional[int] = None, workers: int = 1) -> None:
	if out_dir is None:
		out_dir = Path.cwd() / "downloads" / slug
	data = load_manifest(out_dir)
	episodes: List[Dict[str, Any]] = data.get("episodes", [])
	if not episodes:
		print("[warning] No episodes in manifest.")
		return

	# Build task list
	tasks: List[Tuple[int, str, str]] = []  # (idx, subtitle_folder, hls_folder)
	for idx, ep in enumerate(episodes, start=1):
		# Filter by episode_index (array position) if provided
		if isinstance(episode_index, int) and episode_index > 0 and idx != episode_index:
			continue
		# Filter by episode_number (actual episode number) if provided
		if isinstance(episode_number, int) and episode_number > 0:
			ep_num = ep.get("episode_number")
			if ep_num != episode_number:
				continue
		subtitle_folder = derive_subtitle_folder(ep)
		hls_folder = derive_hls_folder(ep)
		if not hls_folder:
			ep_num = ep.get("episode_number", idx)
			print(f"[skip] Episode {ep_num} (index {idx}): missing HLS info in manifest.")
			continue
		tasks.append((idx, subtitle_folder, hls_folder))

	if not tasks:
		print("[info] No episodes to sync.")
		return

	results: Dict[int, Tuple[int, Dict[str, Any]]] = {}
	print(f"[info] Starting sync with workers={max(1, int(workers))}")
	if int(workers) <= 1 or len(tasks) == 1:
		# Serial
		for idx, subtitle_folder, hls_folder in tasks:
			ep_num = episodes[idx - 1].get("episode_number", idx)
			print(f"\n[episode {ep_num} (index {idx})] subtitle_folder={subtitle_folder} hls_folder={hls_folder}")
			results[idx] = call_sync(subtitle_folder, hls_folder)
	else:
		# Parallel using threads (network-bound)
		with ThreadPoolExecutor(max_workers=int(workers)) as executor:
			future_to_idx = {
				executor.submit(call_sync, subtitle_folder, hls_folder): idx
				for (idx, subtitle_folder, hls_folder) in tasks
			}
			for future in as_completed(future_to_idx):
				idx = future_to_idx[future]
				try:
					results[idx] = future.result()
				except Exception as e:
					print(f"[error] Episode {idx} sync failed with exception: {e}", file=sys.stderr)
					results[idx] = (0, {"error": str(e)})

	# Apply results to manifest in episode order and save once
	for idx, ep in enumerate(episodes, start=1):
		if idx in results:
			status, payload = results[idx]
			ep.setdefault("subtitles_sync", {})
			ep["subtitles_sync"] = {"status": status, **payload}

	save_manifest(out_dir, data)
	print(f"\n[success] Step 5 completed. Manifest updated: {manifest_path_for(out_dir)}")


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
	import argparse
	parser = argparse.ArgumentParser(description="Step 5: Sync subtitles cache per episode (parallelizable)")
	parser.add_argument("slugs", nargs="+", help="Show slug(s) - can specify multiple shows")
	parser.add_argument("--out", dest="out_dir", default=None, help="Output dir (default: ./downloads/<slug>)")
	parser.add_argument("--episode-index", type=int, default=None, help="Only sync this 1-based episode index (array position)")
	parser.add_argument("--episode-number", type=int, default=None, help="Only sync this episode number (from manifest episode_number field)")
	parser.add_argument("--workers", type=int, default=1, help="Number of parallel workers for per-episode sync")
	return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> None:
	args = parse_args(argv)
	slugs: List[str] = args.slugs
	out_dir: Optional[Path] = Path(args.out_dir) if args.out_dir else None
	workers: int = getattr(args, "workers", 1) or 1
	
	print(f"[info] Processing {len(slugs)} show(s): {', '.join(slugs)}")
	
	for i, slug in enumerate(slugs, 1):
		print(f"\n=== [{i}/{len(slugs)}] Processing show: {slug} ===")
		try:
			step5_sync_cache(slug=slug, out_dir=out_dir, episode_index=getattr(args, "episode_index", None), episode_number=getattr(args, "episode_number", None), workers=workers)
		except Exception as e:
			print(f"[error] Failed to process show '{slug}': {e}", file=sys.stderr)
			continue
	
	print(f"\n[success] Completed processing all {len(slugs)} show(s)")


if __name__ == "__main__":
	main()
