import assert from "node:assert/strict";
import {
  type EmbeddingAdapter,
  EmbeddingFailure,
  requestOrderedEmbeddings,
} from "../src/lib/ai/embedding-transport";

function vector(value: number): number[] {
  return [value, value + 0.1, value + 0.2];
}

{
  const batchSizes: number[] = [];
  const adapter: EmbeddingAdapter = {
    provider: "openai",
    maxBatchSize: 2,
    async embedBatch(request) {
      batchSizes.push(request.inputs.length);
      return {
        items: request.inputs
          .map((input, index) => ({
            index,
            embedding: vector(Number(input.replace("input-", ""))),
          }))
          .reverse(),
      };
    },
  };

  const embeddings = await requestOrderedEmbeddings(adapter, {
    inputs: ["input-1", "input-2", "input-3"],
    modelId: "text-embedding-test",
    expectedDimensions: 3,
  });

  assert.deepEqual(batchSizes, [2, 1]);
  assert.deepEqual(embeddings, [vector(1), vector(2), vector(3)]);
}

{
  const batchSizes: number[] = [];
  const adapter: EmbeddingAdapter = {
    provider: "openai",
    maxBatchSize: 4,
    async embedBatch(request) {
      batchSizes.push(request.inputs.length);
      if (request.inputs.length > 1) {
        throw new EmbeddingFailure(
          "request_headers_too_large",
          "headers too large",
          request.diagnostics,
          { retryable: true },
        );
      }
      return {
        items: [{ index: 0, embedding: vector(request.inputs[0].length) }],
      };
    },
  };

  const embeddings = await requestOrderedEmbeddings(adapter, {
    inputs: ["aa", "bbb", "cccc"],
    modelId: "text-embedding-test",
    expectedDimensions: 3,
  });

  assert.deepEqual(batchSizes, [3, 2, 1, 1, 1]);
  assert.deepEqual(embeddings, [vector(2), vector(3), vector(4)]);
}

{
  let attempts = 0;
  const adapter: EmbeddingAdapter = {
    provider: "openai",
    maxBatchSize: 8,
    async embedBatch(request) {
      attempts += 1;
      if (attempts === 1) {
        throw new EmbeddingFailure(
          "request_failed",
          "rate limit",
          request.diagnostics,
          { retryable: true },
        );
      }
      return {
        items: request.inputs.map((_input, index) => ({
          index,
          embedding: vector(index),
        })),
      };
    },
  };

  await requestOrderedEmbeddings(
    adapter,
    {
      inputs: ["one", "two"],
      modelId: "text-embedding-test",
      expectedDimensions: 3,
    },
    { sleep: async () => {} },
  );

  assert.equal(attempts, 2);
}

{
  const adapter: EmbeddingAdapter = {
    provider: "openai",
    maxBatchSize: 8,
    async embedBatch() {
      return { items: [{ index: 0, embedding: [1, 2] }] };
    },
  };

  await assert.rejects(
    () =>
      requestOrderedEmbeddings(adapter, {
        inputs: ["one"],
        modelId: "text-embedding-test",
        expectedDimensions: 3,
      }),
    (error) =>
      error instanceof EmbeddingFailure &&
      error.code === "dimension_mismatch",
  );
}

{
  const adapter: EmbeddingAdapter = {
    provider: "openai",
    maxBatchSize: 8,
    async embedBatch() {
      return {
        items: [
          { index: 0, embedding: vector(0) },
          { index: 0, embedding: vector(1) },
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      requestOrderedEmbeddings(adapter, {
        inputs: ["one", "two"],
        modelId: "text-embedding-test",
        expectedDimensions: 3,
      }),
    (error) =>
      error instanceof EmbeddingFailure && error.code === "response_ordering",
  );
}

console.log("Embedding transport tests passed");
