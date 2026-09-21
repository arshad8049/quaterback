require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TaskContractSchema, ClarifyingResponseSchema } = require('./schema');

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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
  if (process.env.QB_PROXY_URL) {
    return compileViaProxy(request, repoContext, clarification);
  }
  return compileViaApi(request, repoContext, clarification);
}

async function compileViaApi(request, repoContext, clarification) {
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is required when QB_PROXY_URL is not set.');
  }

  const userContent = buildUserContent(request, repoContext, clarification);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [{ role: 'user', content: userContent }]
  });

  return parseAndValidate(response.content[0].text, request);
}

async function compileViaProxy(request, repoContext, clarification) {
  const userContent = buildUserContent(request, repoContext, clarification);

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  };

  const headers = { 'content-type': 'application/json' };
  if (process.env.QB_PROXY_SECRET) {
    headers['x-proxy-secret'] = process.env.QB_PROXY_SECRET;
  }

  const res = await fetch(`${process.env.QB_PROXY_URL}/compile`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Proxy error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty response from proxy');

  return parseAndValidate(text, request);
}

function buildUserContent(request, repoContext, clarification) {
  let content = `REQUEST:\n${request}`;
  if (clarification) content += `\n\nCLARIFICATION:\n${clarification}`;
  if (repoContext)   content += `\n\nREPO CONTEXT:\n${repoContext}`;
  return content;
}

function parseAndValidate(text, request) {
  const raw = parseJSON(text, request);

  if (raw.clarifying_question && !raw.goal) {
    return ClarifyingResponseSchema.parse(raw);
  }

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
  const stripped = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (err) {
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
