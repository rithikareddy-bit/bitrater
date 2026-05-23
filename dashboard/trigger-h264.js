const { MongoClient } = require('mongodb');
const fs = require('fs');

const uri = fs.readFileSync('.env.local', 'utf8').match(/MONGO_URI='([^']+)'/)[1];
const S3 = 'https://s3.ap-south-2.amazonaws.com/sanity-dev-store/uploads/episodes/test-jas/ep-003/1779337895271-9PM_SHOW_CUT_.mp4';
const EID = 'c1ae0631-c506-4d86-beb0-d035283802db';

(async () => {
  const c = new MongoClient(uri);
  await c.connect();

  const lab = await c.db('chai_q_lab').collection('video_episodes').findOne(
    { episode_id: EID },
    { projection: { source_fps: 1, 'golden_recipes.resolutions': 1, gcp_job_status_h264: 1 } },
  );
  const hasFps = !!lab?.source_fps;
  const hasRecipe = !!lab?.golden_recipes?.resolutions?.['1080p']?.h264;
  console.log('lab found:', !!lab);
  console.log('source_fps:', lab?.source_fps);
  console.log('h264 1080p recipe present:', hasRecipe);
  console.log('current gcp_job_status_h264:', lab?.gcp_job_status_h264);
  console.log('lab ready?', hasFps && hasRecipe);

  const r = await c.db('master').collection('showcache').updateOne(
    { 'episodes.id': EID },
    { $set: { 'episodes.$.s3_url': S3, 'episodes.$.s3_url_updated_at': new Date(), updated_at: new Date() } },
  );
  console.log('showcache update matched/modified:', r.matchedCount, r.modifiedCount);

  await c.close();
})().catch((e) => { console.error(e); process.exit(1); });
