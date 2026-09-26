// Which cloud owns a stored workflow/job id. Describe/stop/terminate always go
// to the id's own cloud, so runs started before or after a cutover (or a revert
// to AWS) stay readable and stoppable. CLOUD_PROVIDER only picks where NEW runs start.
//   arn:aws:...                 AWS Step Functions execution
//   azdf:<orchestrator>:<id>    Azure Durable Functions instance
//   azb:<job>/<task>            Azure Batch task
//   acaj:<job>/<execution>      Azure Container Apps Job execution
//   anything else               AWS (Batch job ids are bare UUIDs)
export const AZURE_PREFIXES = ['azdf:', 'azb:', 'acaj:'];

export function providerOfId(id) {
  const s = String(id || '');
  return AZURE_PREFIXES.some((p) => s.startsWith(p)) ? 'azure' : 'aws';
}

// Shadow stamp: a stored AWS id (e.g. copied from prod) must never be described,
// stopped or terminated — that would call PROD Step Functions / Batch.
export function assertIdAllowed(id) {
  if ((process.env.SHADOW_MODE || 'false').toLowerCase() === 'true' && providerOfId(id) === 'aws') {
    throw new Error(`refusing AWS id in shadow mode: ${String(id).slice(0, 80)}`);
  }
}

export function parseDurableId(id) {
  const [, orchestrator, ...rest] = String(id).split(':');
  return { orchestrator, instanceId: rest.join(':') };
}

export function parseBatchId(id) {
  const [job, ...task] = String(id).slice('azb:'.length).split('/');
  return { job, task: task.join('/') };
}
