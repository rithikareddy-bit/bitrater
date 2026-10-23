// Invoke a pipeline function on AWS Lambda or Azure, with a Lambda-shaped result.
//
// Callers pass the same InvokeCommand input they always built. On AWS it is sent
// unchanged. On Azure it becomes POST {FUNCTIONS_BASE_URL}/api/invoke/<fn>
// (mode=async for InvocationType 'Event'), and the response is wrapped back
// into { Payload, FunctionError } so route code stays the same.
// The provider is chosen per function (invokeProvider), so e.g. the resigner can
// stay on AWS until its own cutover (INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS=aws).
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { invokeProvider } from '@/lib/config';

let lambdaClient;
function lambda() {
  if (!lambdaClient) lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
  return lambdaClient;
}

// True when the route's own "<X>_LAMBDA_ARN not configured" check applies.
export function needsLambdaArn(fn) {
  return invokeProvider(fn) !== 'azure';
}

export async function invokeFunction(fn, params) {
  if (invokeProvider(fn) !== 'azure') {
    return lambda().send(new InvokeCommand(params));
  }
  const mode = params.InvocationType === 'Event' ? 'async' : 'sync';
  const url = new URL(`/api/invoke/${fn}`, process.env.FUNCTIONS_BASE_URL);
  url.searchParams.set('mode', mode);
  const res = await fetch(url, {
    method: 'POST',
    // Functions' HTTP front end cuts at ~230 s; fail clearly just before that.
    signal: AbortSignal.timeout(225_000),
    headers: { 'content-type': 'application/json', 'x-functions-key': process.env.FUNCTIONS_INVOKE_KEY || '' },
    body: params.Payload ? Buffer.from(params.Payload).toString() : '{}',
  });
  const text = await res.text();
  // Like the Lambda SDK: a failed *invocation* (bad key 401/403, unknown function 404,
  // throttling, host down, or any failed async start) throws. Only a handler error
  // (sync: 500 with a Lambda-style {errorMessage, ...} body) comes back as FunctionError.
  if (!res.ok && (mode === 'async' || !isHandlerError(res.status, text))) {
    throw new Error(`Azure invoke ${fn} (${mode}) failed: HTTP ${res.status}${text ? ` ${text.slice(0, 300)}` : ''}`);
  }
  // /api/invoke returns 200 with the handler's result, 202 for async, or 500 with a
  // Lambda-style error body {errorMessage, errorType, stackTrace}.
  return {
    StatusCode: res.status,
    Payload: Buffer.from(text || '{}'),
    ...(res.ok ? {} : { FunctionError: 'Unhandled' }),
  };
}

function isHandlerError(status, text) {
  if (status !== 500 || !text) return false;
  try {
    return typeof JSON.parse(text)?.errorMessage === 'string';
  } catch {
    return false;
  }
}
