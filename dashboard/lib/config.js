// Runtime names/flags that differ between prod and the Azure shadow stamp.
//
// Every default equals what the code did before the Azure migration, so with no
// env vars set the dashboard behaves exactly like AWS prod today
// (test/config.test.mjs proves it). The Azure shadow stamp sets SHADOW_MODE=true
// plus shadow names; assertIsolation() (called from instrumentation.ts) refuses
// to start if anything could reach prod. See AZURE-MIGRATION-PLAN.md §0 (P2).

const env = process.env;

export const DB_LAB = env.DB_LAB || 'chai_q_lab';
export const DB_MASTER = env.DB_MASTER || 'master';
export const DB_DEV = env.DB_DEV || 'gld2sqs'; // dev/subtitle cluster (getDevClientPromise)

export const CLOUD_PROVIDER = env.CLOUD_PROVIDER || 'aws'; // where NEW workflows/jobs start
export const UPLOAD_PROVIDER = env.UPLOAD_PROVIDER || 's3'; // 's3' | 'azure'
export const SHADOW_MODE = (env.SHADOW_MODE || 'false').toLowerCase() === 'true';
export const VTT_ENABLED = (env.VTT_ENABLED || 'true').toLowerCase() === 'true';
export const UPLOAD_DEV_SYNC_ENABLED = (env.UPLOAD_DEV_SYNC_ENABLED || 'true').toLowerCase() === 'true';

// Per-function override so e.g. the resigner can stay on AWS after the other
// backends move: INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS=aws.
export function invokeProvider(fn) {
  const key = `INVOKE_PROVIDER_${String(fn).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[key] || process.env.CLOUD_PROVIDER || 'aws';
}

export function isolationViolations(e = process.env) {
  if ((e.SHADOW_MODE || 'false').toLowerCase() !== 'true') return [];
  const problems = [];
  for (const [name, def] of [['DB_LAB', 'chai_q_lab'], ['DB_MASTER', 'master'], ['MONGO_DATABASE', 'master']]) {
    const v = e[name] || def;
    if (!v.endsWith('_shadow')) problems.push(`${name}=${v} must end with _shadow`);
  }
  if ((e.TRAILER_SCANNER_ENABLED || 'true').toLowerCase() !== 'false') problems.push('TRAILER_SCANNER_ENABLED must be false');
  if ((e.VTT_ENABLED || 'true').toLowerCase() !== 'false') problems.push('VTT_ENABLED must be false (vtt-worker writes prod)');
  if ((e.UPLOAD_DEV_SYNC_ENABLED || 'true').toLowerCase() !== 'false') problems.push('UPLOAD_DEV_SYNC_ENABLED must be false');
  if ((e.CLOUD_PROVIDER || 'aws') !== 'azure') problems.push('CLOUD_PROVIDER must be azure (shadow must not start AWS prod workflows)');
  for (const [k, v] of Object.entries(e)) {
    if (k.startsWith('INVOKE_PROVIDER_') && v !== 'azure') problems.push(`${k}=${v} must be azure (would call prod Lambdas)`);
  }
  if ((e.UPLOAD_PROVIDER || 's3') !== 'azure' || !String(e.UPLOAD_AZURE_CONTAINER || '').includes('shadow')) {
    problems.push('shadow uploads must go to an Azure *shadow* container (UPLOAD_PROVIDER=azure, UPLOAD_AZURE_CONTAINER=*shadow*)');
  }
  return problems;
}

export function assertIsolation(e = process.env) {
  const problems = isolationViolations(e);
  if (problems.length) throw new Error(`Shadow isolation check failed: ${problems.join('; ')}`);
}
