require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TaskContractSchema, ClarifyingResponseSchema } = require('./schema');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');

/**
 * Compile a natural-language developer request into a TaskContract.
 *
 * @param {string} request - The raw developer request
 * @param {string|null} repoContext - Optional repo context string (tree + file snippets)
 * @param {string|null} clarification - Optional answer to a previous clarifying question
 * @returns {object} TaskContract (validated) or ClarifyingResponse { ambiguity_flags, clarifying_question }
 */
async function compile(request, repoContext = null, clarification = null) {
  let userContent = `REQUEST:\n${request}`;

  if (clarification) {
    userContent += `\n\nCLARIFICATION:\n${clarification}`;
  }

  if (repoContext) {
    userContent += `\n\nREPO CONTEXT:\n${repoContext}`;
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' } // cache the system prompt across calls
      }
    ],
    messages: [{ role: 'user', content: userContent }]
  });

  const raw = parseJSON(response.content[0].text, request);

  // If compiler returned a clarifying question, return that shape
  if (raw.clarifying_question && !raw.goal) {
    return ClarifyingResponseSchema.parse(raw);
  }

  // Otherwise build the full TaskContract
  const contract = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    raw_request: request,
    repo_path: null,
    ...raw
  };

  return TaskContractSchema.parse(contract);
}

function parseJSON(text, request) {
  // Strip any accidental markdown fences the model may add
  const stripped = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (err) {
    // Try to extract a JSON object from inside the text
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {}
    }
    throw new Error(`Intent compiler returned non-JSON output for request: "${request.slice(0, 60)}..."\n\nRaw response:\n${text}`);
  }
}

module.exports = { compile };
