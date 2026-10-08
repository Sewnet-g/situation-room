// Registers the gateway's model list ($SR_MODELS) as provider "gateway", priced from the gateway when cached.
import { readFileSync } from 'node:fs';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';

const catalog = JSON.parse(readFileSync(process.env.SR_MODELS, 'utf8'));
const API = process.env.SR_PI_OTHER_API || 'openai-completions';
let prices = {};
try { prices = JSON.parse(readFileSync(process.env.SR_PRICES, 'utf8')); } catch {}

function model(m) {
  const [input, output, cacheRead, cacheWrite] = (prices[m.id] || m.cost).map((v, k) => v ?? m.cost[k]);
  const base = { id: m.id, name: m.label, contextWindow: m.ctx, maxTokens: m.out, cost: { input, output, cacheRead, cacheWrite } };
  if (m.base) {
    const b = getBuiltinModel('anthropic', m.base);
    return { ...base, api: 'anthropic-messages', reasoning: b.reasoning, thinkingLevelMap: b.thinkingLevelMap, input: b.input,
      compat: { ...b.compat, supportsStrictTools: false, supportsMidConvoEffort: false, supportsMidConvoToolChanges: false } };
  }
  return { ...base, api: API, baseUrl: process.env.SR_GATEWAY_URL, reasoning: false, input: m.vision ? ['text', 'image'] : ['text'],
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: 'max_tokens' } };
}

export default function (pi) {
  pi.registerProvider('gateway', {
    baseUrl: process.env.SR_GATEWAY_URL,
    apiKey: '$SR_GATEWAY_KEY',
    api: 'anthropic-messages',
    authHeader: true,
    models: catalog.map(model),
  });
}
