import { searchBlob } from '../core/blob-search.js?v=0.14.5';

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_FILE_MATCH_LIMIT = 200;
const DEFAULT_TOTAL_MATCH_LIMIT = 2000;

self.onmessage = async (event) => {
  const { requestId, batchId, pattern: rawPattern, jobs = [], chunkBytes = DEFAULT_CHUNK_BYTES, perFileLimit = DEFAULT_FILE_MATCH_LIMIT, totalLimit = DEFAULT_TOTAL_MATCH_LIMIT } = event.data || {};
  try {
    const pattern = rawPattern instanceof Uint8Array ? rawPattern : new Uint8Array(rawPattern || []);
    if (!pattern.length) throw new Error('Search pattern is empty.');
    let totalMatches = 0;
    let processed = 0;
    let capped = false;

    for (let index = 0; index < jobs.length; index += 1) {
      if (totalMatches >= totalLimit) { capped = true; break; }
      const job = jobs[index];
      const result = await searchBlob(job?.blob, pattern, {
        chunkBytes,
        limit: Math.min(perFileLimit, totalLimit - totalMatches),
      });
      totalMatches += result.offsets.length;
      processed = index + 1;
      if (result.offsets.length || result.truncated) self.postMessage({ type: 'file', requestId, batchId, id: job.id, offsets: result.offsets, truncated: result.truncated });
      if ((index + 1) % 32 === 0 || index + 1 === jobs.length) self.postMessage({ type: 'progress', requestId, batchId, done: index + 1, total: jobs.length });
    }

    self.postMessage({ type: 'done', requestId, batchId, processed, totalMatches, capped: capped || totalMatches >= totalLimit });
  } catch (error) {
    self.postMessage({ type: 'error', requestId, batchId, message: error instanceof Error ? error.message : String(error) });
  }
};
