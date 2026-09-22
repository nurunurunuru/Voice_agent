const { MongoClient, ServerApiVersion } = require("mongodb");

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI environment variable is missing");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;

async function connectMongoDB() {
  if (db) {
    return db;
  }

  await client.connect();

  await client.db("admin").command({
    ping: 1,
  });

  db = client.db("voice_agent");

  console.log("✅ MongoDB connected");

  return db;
}

async function getDatabase() {
  if (!db) {
    await connectMongoDB();
  }

  return db;
}

module.exports = {
  connectMongoDB,
  getDatabase,
};