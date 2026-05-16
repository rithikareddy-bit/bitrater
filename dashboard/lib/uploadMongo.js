import clientPromise, { getDevClientPromise } from '@/lib/mongodb';

export async function getProdShowcase() {
  const client = await clientPromise();
  return client.db('master').collection('showcache');
}

export async function getDevShowcase() {
  const p = getDevClientPromise();
  if (!p) return null;
  try {
    const client = await p;
    return client.db('gld2sqs').collection('showcache');
  } catch {
    return null;
  }
}

export function findEpisode(show, episodeNumber) {
  const eps = Array.isArray(show?.episodes) ? show.episodes : [];
  const target = Number(episodeNumber);
  const idx = eps.findIndex((e) => Number(e?.episode_number) === target);
  if (idx === -1) return { idx: -1, episode: null };
  return { idx, episode: eps[idx] };
}
