import clientPromise, { getDevClientPromise } from '@/lib/mongodb';
import { DB_MASTER, DB_DEV } from '@/lib/config';

export async function getProdShowcase() {
  const client = await clientPromise();
  return client.db(DB_MASTER).collection('showcache');
}

export async function getDevShowcase() {
  const p = getDevClientPromise();
  if (!p) return null;
  try {
    const client = await p;
    return client.db(DB_DEV).collection('showcache');
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
