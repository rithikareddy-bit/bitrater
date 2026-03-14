#!/usr/bin/env python3
"""
Step 4: Upload subtitles to media API (serial, ordered)
- Reads manifest from step 3
- Uploads VTT files in order for each episode
- Updates manifest with upload response
"""

import os
import json
import argparse
import requests
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional


def step4_upload_subtitles(slug, episode_index: Optional[int] = None):
    """Upload subtitles for all episodes in manifest order"""
    
    # Load manifest
    manifest_path = f"downloads/{slug}/transfer_manifest.json"
    if not os.path.exists(manifest_path):
        print(f"Error: Manifest not found at {manifest_path}")
        return False
    
    with open(manifest_path, 'r') as f:
        manifest = json.load(f)
    
    print(f"[step4] Uploading subtitles for {len(manifest['episodes'])} episodes...")
    
    # Process each episode serially
    for i, episode in enumerate(manifest['episodes']):
        # If a specific episode index (1-based) is requested, skip others
        if isinstance(episode_index, int) and episode_index > 0 and (i + 1) != episode_index:
            continue
        # Derive episode_stem from filename
        file_path = episode['file']
        episode_stem = Path(file_path).stem  # removes .mp4 extension
        print(f"\n[episode {i+1}] Processing {episode_stem}")
        
        # Find VTT files for this episode
        vtt_dir = Path(f"subtitles/{slug}/vtt/{episode_stem}")
        if not vtt_dir.exists():
            print(f"  No VTT directory found: {vtt_dir}")
            continue
        
        vtt_files = list(vtt_dir.glob("*.vtt"))
        if not vtt_files:
            print(f"  No VTT files found in {vtt_dir}")
            continue
        
        # Sort by modification time to preserve order
        vtt_files.sort(key=lambda x: x.stat().st_mtime)
        
        # Extract languages from filenames
        languages = []
        for vtt_file in vtt_files:
            # Extract language from filename like "episode_stem_en.vtt"
            lang_match = vtt_file.stem.split('_')[-1]
            if lang_match in ['en', 'te', 'tlg']:
                languages.append(lang_match)
        
        if not languages:
            print(f"  No valid language codes found in filenames")
            continue
        
        print(f"  Languages: {languages}")
        print(f"  Files: {[f.name for f in vtt_files]}")
        
        # Upload subtitles
        success, api_payload = upload_one_episode_subtitles(episode_stem, vtt_files, languages)
        
        # Update manifest
        if 'subtitles_upload' not in episode:
            episode['subtitles_upload'] = {}
        
        episode['subtitles_upload']['languages'] = languages
        episode['subtitles_upload']['files'] = [str(f) for f in vtt_files]
        episode['subtitles_upload']['success'] = success
        # Persist the API response exactly as returned for diagnostics (success or failure)
        episode['subtitles_upload']['response'] = api_payload
        episode['subtitles_upload']['timestamp'] = datetime.now().isoformat()
        # Persist API-derived subtitle folder if provided, so Step 5 can use it
        try:
            if isinstance(api_payload, dict):
                # Prefer top-level key if present
                if 'subtitle_folder' in api_payload:
                    episode['subtitles_upload']['subtitle_folder'] = api_payload.get('subtitle_folder')
                # Some responses may nest data
                elif 'data' in api_payload and isinstance(api_payload['data'], dict) and 'subtitle_folder' in api_payload['data']:
                    episode['subtitles_upload']['subtitle_folder'] = api_payload['data'].get('subtitle_folder')
        except Exception:
            pass
    
    # Save updated manifest
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    
    print(f"\n[success] Step 4 completed. Manifest updated: {manifest_path}")
    return True


def upload_one_episode_subtitles(episode_stem, vtt_files, languages):
    """Upload subtitles for one episode

    Returns (success: bool, response_payload: Optional[dict])
    """
    
    url = "https://media-api.chaishots.in/upload-subtitles/"
    
    # Prepare form data - use lists for multiple values
    files = []
    data = {
        'bucket': 'chai-shots-manifests',
        'languages': languages,  # Send as list
        'subtitles': []  # Will be populated with file handles
    }
    
    # Add files in order
    for vtt_file in vtt_files:
        files.append(('subtitles', (vtt_file.name, open(vtt_file, 'rb'), 'text/vtt')))
    
    try:
        print(f"  [upload] Sending {len(files)} subtitle files...")
        response = requests.post(url, data=data, files=files)
        
        # Close file handles
        for _, (_, file_handle, _) in files:
            file_handle.close()
        
        print(f"  [upload] Response: status={response.status_code}")
        payload = None
        try:
            payload = response.json()
        except Exception:
            payload = {"text": response.text[:1000]}
        if response.status_code == 200:
            print(f"  [upload] Success: {str(payload)[:200]}...")
            return True, payload
        else:
            print(f"  [upload] Error: {str(payload)[:200]}...")
            return False, payload
            
    except Exception as e:
        print(f"  [upload] Exception: {e}")
        # Close file handles on error
        for _, (_, file_handle, _) in files:
            try:
                file_handle.close()
            except:
                pass
        return False, None


def main():
    parser = argparse.ArgumentParser(description="Step 4: Upload subtitles to media API")
    parser.add_argument('slugs', nargs='+', help='Show slug(s) - can specify multiple shows')
    parser.add_argument('--episode-index', type=int, default=None, help='Only upload subtitles for this 1-based episode index')
    
    args = parser.parse_args()
    
    print(f"[info] Processing {len(args.slugs)} show(s): {', '.join(args.slugs)}")
    
    for i, slug in enumerate(args.slugs, 1):
        print(f"\n=== [{i}/{len(args.slugs)}] Processing show: {slug} ===")
        try:
            success = step4_upload_subtitles(slug, episode_index=args.episode_index)
            if not success:
                print(f"[error] Failed to process show '{slug}'", file=sys.stderr)
                continue
        except Exception as e:
            print(f"[error] Failed to process show '{slug}': {e}", file=sys.stderr)
            continue
    
    print(f"\n[success] Completed processing all {len(args.slugs)} show(s)")


if __name__ == "__main__":
    main()