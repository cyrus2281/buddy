import { secrets } from '../secrets.js';
import { settings } from '../settings.js';
import { anthropicModel } from '../notes/model.js';
import { anthropicBaseUrl, openaiBaseUrl, operatorUnavailableReason } from '../providers.js';
import { AnthropicClient, type ModelClient } from './client.js';
import { OpenAIChatModelClient } from './openai-client.js';
import { operatorPricer, type Pricer } from './budget.js';
import type { ProviderId } from '../../shared/types.js';

/// What a cua-backend run drives with: the client, the model id, and how a
/// turn of it is priced. The toolset backend does not come through here — its
/// setup in `orchestrator.start()` is unchanged, so the default path is
/// byte-for-byte what it was.

export interface CuaOperatorSetup {
  client: ModelClient;
  model: string;
  provider: ProviderId;
  price: Pricer;
  /** One line for the log: how the cost budget is being metered. */
  priceBasis: string;
}

/** Throws `operatorUnavailableReason()` — the sentence Settings shows — when
 *  there is nothing to drive with. */
export function cuaOperatorSetup(): CuaOperatorSetup {
  const reason = operatorUnavailableReason();
  if (reason) throw new Error(reason);
  const s = settings.get();
  const provider = s.operatorProvider;

  if (provider === 'anthropic') {
    const model = anthropicModel('operator');
    const { price, basis } = operatorPricer('anthropic', model);
    return {
      client: new AnthropicClient(secrets.get('anthropic')!, anthropicBaseUrl()),
      model,
      provider,
      price,
      priceBasis: basis,
    };
  }
  if (provider === 'openai') {
    const model = s.openaiModel.trim();
    const { price, basis } = operatorPricer('openai', model);
    return {
      client: new OpenAIChatModelClient({
        baseUrl: openaiBaseUrl(),
        apiKey: secrets.get('openai'),
        label: 'OpenAI',
        flavor: 'openai',
      }),
      model,
      provider,
      price,
      priceBasis: basis,
    };
  }
  const model = s.localModel.trim();
  const { price, basis } = operatorPricer('local', model);
  return {
    client: new OpenAIChatModelClient({
      baseUrl: s.localBaseUrl.trim(),
      apiKey: null,
      label: `local (${model})`,
      flavor: 'local',
    }),
    model,
    provider,
    price,
    priceBasis: basis,
  };
}
