import { MongoClient } from 'mongodb';

let clientPromise;

// Lazy init — deferred until first request so Next.js build phase doesn't fail
export default function getClientPromise() {
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
