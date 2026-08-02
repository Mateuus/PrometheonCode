import type { AgentSummary } from '../core/types';
import { PrometheonError } from '../utils/errors';
import type { AgentAdapter } from './AgentAdapter';

export class UnknownAgentError extends PrometheonError {
  constructor(agentId: string) {
    super(`Nenhum adaptador registrado com o id "${agentId}".`, 'agent.unknown');
  }
}

/**
 * Registro de adaptadores disponíveis e de qual deles é o Main Agent.
 * A interface nunca referencia um adaptador concreto: sempre passa pelo registro.
 */
export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private mainAgentId: string | null = null;

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.mainAgentId ??= adapter.id;
  }

  has(agentId: string): boolean {
    return this.adapters.has(agentId);
  }

  get(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId);
  }

  require(agentId: string): AgentAdapter {
    const adapter = this.adapters.get(agentId);
    if (adapter === undefined) {
      throw new UnknownAgentError(agentId);
    }
    return adapter;
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  get main(): AgentAdapter {
    if (this.mainAgentId === null) {
      throw new PrometheonError('Nenhum agente registrado.', 'agent.none-registered');
    }
    return this.require(this.mainAgentId);
  }

  /** Troca o Main Agent. Ignora ids desconhecidos lançando erro tipado. */
  setMain(agentId: string): void {
    this.require(agentId);
    this.mainAgentId = agentId;
  }

  async summaries(): Promise<AgentSummary[]> {
    return Promise.all(
      this.list().map(async (adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        transport: adapter.transport,
        available: await adapter.isAvailable(),
        // Só quem tem controle de raciocínio declara os rótulos — é assim que
        // a interface sabe se deve oferecer o seletor de esforço.
        ...(adapter.effortLabels === undefined ? {} : { effortLabels: adapter.effortLabels }),
      })),
    );
  }
}
