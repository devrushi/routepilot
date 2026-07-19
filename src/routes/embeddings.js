import { EmbeddingError } from '../embeddings.js';
import { sendJson, readJsonBody, requireSession, registerErrorStatuses } from '../http-utils.js';

const EMBEDDING_ERROR_STATUS = {
  EMBEDDING_INPUT: 400,
  EMBEDDING_VECTOR: 400,
  EMBEDDING_DIMENSION: 400,
  EMBEDDING_ID: 400,
  EMBEDDING_DRIVER: 400,
};

export function registerEmbeddingRoutes(router, { sessionManager, patternIndex }) {
  registerErrorStatuses(EmbeddingError, EMBEDDING_ERROR_STATUS);

  router.post('/patterns', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const body = await readJsonBody(req);
    const record = await patternIndex.indexPattern(payload.sub, body);
    sendJson(res, 201, { record });
  });

  router.post('/patterns/search', async (req, res) => {
    const payload = await requireSession(req, res, sessionManager);
    if (!payload) return;
    const { topK, ...queryPattern } = await readJsonBody(req);
    const matches = await patternIndex.findSimilarPatterns(payload.sub, queryPattern, topK ? { topK } : {});
    sendJson(res, 200, { matches });
  });
}
