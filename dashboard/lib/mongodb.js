import { MongoClient } from 'mongodb';
import { assertIsolation } from '@/lib/config';

let clientPromise;
let devClientPromise;

// Lazy init — deferred until first request so Next.js build phase doesn't fail
export default function getClientPromise() {
  // Shadow stamp: refuse any data access if a name points at prod (no-op unless
  // SHADOW_MODE=true). Lives here because Next 14 never runs instrumentation.ts
  // (experimental.instrumentationHook is off, as on AWS prod).
  assertIsolation();
  if (clientPromise) return clientPromise;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI environment variable is not set');

  if (process.env.NODE_ENV === 'development') {
    if (!global._mongoClientPromise) {
      const client = new MongoClient(uri);
      global._mongoClientPromise = client.connect();
    }
    clientPromise = global._mongoClientPromise;
  } else {
    const client = new MongoClient(uri);
    clientPromise = client.connect();
  }

  return clientPromise;
}

// Fallback dev Mongo (same URI as SUBTITLE_MONGO_URI). Returns null when unset
// so callers can short-circuit instead of throwing.
export function getDevClientPromise() {
  assertIsolation();
  if (devClientPromise) return devClientPromise;

  const uri = process.env.SUBTITLE_MONGO_URI;
  if (!uri) return null;

  const client = new MongoClient(uri);
  const promise = client.connect().catch((err) => {
    // Drop the cached rejection so the next request retries instead of being
    // permanently stuck on a transient connect failure.
    if (devClientPromise === promise) devClientPromise = null;
    if (process.env.NODE_ENV === 'development' && global._mongoDevClientPromise === promise) {
      global._mongoDevClientPromise = null;
    }
    throw err;
  });
  if (process.env.NODE_ENV === 'development') {
    if (!global._mongoDevClientPromise) global._mongoDevClientPromise = promise;
    devClientPromise = global._mongoDevClientPromise;
  } else {
    devClientPromise = promise;
  }

  return devClientPromise;
}
