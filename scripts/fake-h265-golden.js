/**
 * Inserts fake 720p/480p H.265 golden_recipes for two episodes so the
 * "Run GCP" button enables. Run from /dashboard so the `mongodb` module
 * resolves: `node ../scripts/fake-h265-golden.js`
 *
 * Targets:
 *   nirudhyogi-to-ceo_ep_14 -> 720p:500, 480p:100
 *   nirudhyogi-to-ceo_ep_19 -> 720p:1200, 480p:200
 */
const { MongoClient } = require('mongodb');

const URI = process.env.MONGO_URI;
if (!URI) {
  console.error('Set MONGO_URI before running.');
  process.exit(1);
}

const TARGETS = [
  { episode_id: '8ae737b7-5fc0-41bc-a01f-54845dcd32fe', kbps_1080: 1800, kbps_720: 500,  kbps_480: 100 }, // ep_14
  { episode_id: 'ff624dfc-9181-4053-9298-a40a1a64799a', kbps_1080: 3200, kbps_720: 1200, kbps_480: 200 }, // ep_19
];

(async () => {
  const client = new MongoClient(URI);
  await client.connect();
  const col = client.db('chai_q_lab').collection('video_episodes');

  for (const t of TARGETS) {
    const before = await col.findOne(
      { episode_id: t.episode_id },
      { projection: { episode_id: 1, 'golden_recipes.resolutions': 1, lab_status_h265: 1 } },
    );
    if (!before) {
      console.log(`SKIP ${t.episode_id}: not found`);
      continue;
    }
    console.log(`BEFORE ${t.episode_id}:`, JSON.stringify(before.golden_recipes?.resolutions, null, 2));

    const res = await col.updateOne(
      { episode_id: t.episode_id },
      {
        $set: {
          'golden_recipes.resolutions.1080p.h265': {
            bitrate_kbps: t.kbps_1080,
            vmaf_attained: 95,
            synthetic: true,
          },
          'golden_recipes.resolutions.720p.h265': {
            bitrate_kbps: t.kbps_720,
            vmaf_attained: 95,
            synthetic: true,
          },
          'golden_recipes.resolutions.480p.h265': {
            bitrate_kbps: t.kbps_480,
            vmaf_attained: 95,
            synthetic: true,
          },
        },
      },
    );
    console.log(`UPDATE ${t.episode_id}:`, res.matchedCount, res.modifiedCount);
  }

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
