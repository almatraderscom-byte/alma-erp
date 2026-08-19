import test from 'node:test'
import assert from 'node:assert/strict'
import {
  gptImage2OutputCostUsd,
  gptImage2OutputTokens,
  gptImage2UsageCostUsd,
} from '../openai-cost.mjs'

test('GPT Image 2 calculator matches OpenAI examples and ALMA dimensions', () => {
  assert.equal(gptImage2OutputTokens(1024, 1024, 'low'), 196)
  assert.equal(gptImage2OutputCostUsd(1024, 1024, 'medium'), 0.05268)
  assert.equal(gptImage2OutputCostUsd(1856, 2304, 'high'), 0.34797)
})

test('GPT Image 2 usage settlement includes text, reference images, and output', () => {
  assert.equal(gptImage2UsageCostUsd({
    input_tokens_details: { text_tokens: 100, image_tokens: 2000 },
    output_tokens: 5000,
  }), 0.1665)
  assert.equal(gptImage2UsageCostUsd({}), null)
})
