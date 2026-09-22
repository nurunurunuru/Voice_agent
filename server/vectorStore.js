// server/vectorStore.js

const { getDatabase } = require("./mongodb");
const { cosineSimilarity } = require("./embeddings");

const COLLECTION_NAME = "agents";

async function getCollection() {
  const db = await getDatabase();
  return db.collection(COLLECTION_NAME);
}

// ============================================================
// SAVE AGENT
// ============================================================

async function saveStore(agentId, store) {
  const collection = await getCollection();

  await collection.replaceOne(
    { agentId },
    {
      ...store,
      agentId,
      updatedAt: new Date().toISOString(),
    },
    { upsert: true }
  );

  console.log(`💾 Agent saved to MongoDB: ${agentId}`);
}

// ============================================================
// LOAD AGENT
// ============================================================

async function loadStore(agentId) {
  const collection = await getCollection();

  const store = await collection.findOne(
    { agentId },
    { projection: { _id: 0 } }
  );

  return store || null;
}

// ============================================================
// CHECK AGENT EXISTS
// ============================================================

async function agentExists(agentId) {
  const collection = await getCollection();

  const result = await collection.findOne(
    { agentId },
    {
      projection: {
        _id: 1,
      },
    }
  );

  return !!result;
}

// ============================================================
// LIST AGENTS
// ============================================================

async function listAgents() {
  const collection = await getCollection();

  const agents = await collection
    .find(
      {},
      {
        projection: {
          _id: 0,
          agentId: 1,
        },
      }
    )
    .toArray();

  return agents.map((agent) => agent.agentId);
}

// ============================================================
// SEARCH RAG
// ============================================================

async function search(agentId, queryEmbedding, topK = 5) {
  const store = await loadStore(agentId);

  if (!store || !Array.isArray(store.chunks)) {
    return [];
  }

  const scored = store.chunks.map((c) => ({
    ...c,
    score: cosineSimilarity(
      queryEmbedding,
      c.embedding
    ),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

module.exports = {
  saveStore,
  loadStore,
  agentExists,
  listAgents,
  search,
};