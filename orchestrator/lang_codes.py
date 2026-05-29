"""
Single source of truth for BCP-47 normalization of show source-language strings.

Used by both the video finalize lambda (`gcp_finalize_hls.py`) and the audio
transcoder lambda (`gcp_audio_transcoder.py`). NO top-level os.environ reads here —
this module must be safe to import from any Lambda regardless of which env vars it
sets.
"""

# BCP-47 2-letter codes + display names for the show's source language.
LANG_CODE_NAMES = {
    "kn": "Kannada",
    "te": "Telugu",
    "hi": "Hindi",
    "ta": "Tamil",
    "ml": "Malayalam",
    "bn": "Bengali",
    "mr": "Marathi",
    "gu": "Gujarati",
    "pa": "Punjabi",
    "ur": "Urdu",
    "or": "Odia",
    "as": "Assamese",
    "en": "English",
}
LANG_NAME_TO_CODE = {v.lower(): k for k, v in LANG_CODE_NAMES.items()}

# Display labels for romanized subtitle tracks (video pipeline only, kept here so
# the video module isn't forced to re-define the language list).
ROMANIZED_DISPLAY_NAMES = {
    "kn": "Kanglish",
    "te": "Tinglish",
    "hi": "Hinglish",
    "ta": "Tanglish",
    "ml": "Manglish",
    "bn": "Banglish",
}


def normalize_lang_code(source_language: str) -> str:
    """Normalize a free-form language hint to a BCP-47 2-letter code.

    Accepts: 'kannada', 'Kannada', 'kn', 'KAN' → 'kn'.
    Returns 'xx' when input is empty; otherwise falls back to the first two
    lowercased chars when unknown. (Callers that need HLS-spec 'und' for empty
    should treat 'xx' the same way.)
    """
    s = (source_language or "").strip().lower()
    if not s:
        return "xx"
    if s in LANG_CODE_NAMES:
        return s
    if s in LANG_NAME_TO_CODE:
        return LANG_NAME_TO_CODE[s]
    if s == "kan":
        return "kn"
    return s[:2]
