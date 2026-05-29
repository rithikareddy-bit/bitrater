import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

// GET /api/audio/episodes            -> list podcasts (slug, title, episode_count)
// GET /api/audio/episodes?slug=foo   -> that podcast's episodes + conversion status
export async function GET(request) {
  try {
    const slug = request.nextUrl.searchParams.get('slug');
    const client = await clientPromise();
    const master = client.db('master');
    const lab = client.db('chai_q_lab');

    if (!slug) {
      const shows = await master
        .collection('podcast_showcache')
        .find({}, { projection: { slug: 1, title: 1, language: 1, episodes: 1 } })
        .toArray();
      return NextResponse.json(
        shows
          .map((s) => ({
            slug: s.slug,
            title: s.title,
            language: s.language || null,
            episode_count: (s.episodes || []).filter((e) => e.audio_url).length,
          }))
          .sort((a, b) => (a.title || '').localeCompare(b.title || '')),
      );
    }

    const show = await master
      .collection('podcast_showcache')
      .findOne({ slug }, { projection: { slug: 1, title: 1, episodes: 1 } });
    if (!show) return NextResponse.json({ error: 'podcast not found' }, { status: 404 });

    const episodes = (show.episodes || []).filter((e) => e.audio_url);
    const ids = episodes.map((e) => e.id).filter(Boolean);
    const statuses = await lab
      .collection('audio_episodes')
      .find({ episode_id: { $in: ids } })
      .toArray();
    const byId = Object.fromEntries(statuses.map((s) => [s.episode_id, s]));

    return NextResponse.json({
      slug: show.slug,
      title: show.title,
      episodes: episodes.map((e) => ({
        id: e.id,
        title: e.title,
        episode_number: e.episode_number,
        audio_url: e.audio_url,
        status: byId[e.id]?.gcp_job_status || 'idle',
        output_uri: byId[e.id]?.output_uri || null,
        // public browser-openable master URL (https://storage.googleapis.com/chai-q-audio-public/...).
        // Falls back to the private gs:// path if the public copy hasn't run.
        master_uri:
          byId[e.id]?.public_master_url ||
          (byId[e.id]?.output_uri
            ? byId[e.id].output_uri.replace(/\/?$/, '/') + 'audio_master.m3u8'
            : null),
        public: Boolean(byId[e.id]?.public_master_url),
        ladder: byId[e.id]?.ladder || null,
        error: byId[e.id]?.gcp_error || null,
        // Best-effort public-bucket copy can fail even when the transcode succeeded;
        // surface it so the dashboard can flag the episode (it stays SUCCEEDED).
        publish_error: byId[e.id]?.publish_error || null,
        // Subtitles: same best-effort contract as publish_error. `subtitle_tracks`
        // is the list of advertised tracks; `subtitle_publish_error` (if set) means
        // the audio URL has no subs embedded even though transcode SUCCEEDED.
        subtitle_tracks: byId[e.id]?.subtitle_tracks || null,
        subtitle_publish_error: byId[e.id]?.subtitle_publish_error || null,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
