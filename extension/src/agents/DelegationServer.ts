import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../logger';

/**
 * Servidor MCP local que dá ao agente principal a ferramenta de delegar.
 *
 * É assim que o Prometheon orquestra: o CLI do provedor não sabe o que é um
 * "agente do Prometheon", mas sabe usar ferramentas MCP. O principal recebe
 * duas — listar os agentes disponíveis e delegar uma tarefa a um deles — e o
 * núcleo executa o agente escolhido, que pode ser de **outro provedor**. É o
 * que permite o orquestrador do Claude Code mandar uma pesquisa para um agente
 * do Codex e receber o relatório de volta.
 *
 * O servidor escuta só em `127.0.0.1`, numa porta efêmera, e exige um token de
 * uso único no cabeçalho: qualquer processo da máquina alcança o loopback, e
 * uma ferramenta que executa agentes não pode ficar aberta para quem passar.
 */

/** Agente que o orquestrador pode acionar, como o modelo o enxerga. */
export interface DelegatableAgent {
  readonly name: string;
  /** Função no Prometheon: "Pesquisador", "Testador"… */
  readonly role: string;
  /** Uma linha dizendo quando vale a pena chamá-lo. */
  readonly description: string;
  /** Quantas tarefas ele aceita ao mesmo tempo. */
  readonly slots: number;
}

/**
 * O que se espera de volta de um worker.
 *
 * `report` é trabalho de leitura: pesquisa, análise, revisão. O agente não
 * altera nada e devolve texto. `changes` é trabalho de escrita: o agente recebe
 * uma cópia isolada do repositório e devolve o que mudou nela.
 */
export type DelegationMode = 'report' | 'changes';

/** Delegação em andamento, como o orquestrador a enxerga. */
export interface RunningDelegation {
  readonly ticket: string;
  readonly agent: string;
  readonly task: string;
  readonly mode: DelegationMode;
  readonly seconds: number;
}

export interface DelegationHandlers {
  /** Agentes que podem receber trabalho agora. */
  listAgents(): Promise<readonly DelegatableAgent[]>;
  /**
   * Executa a tarefa no agente pedido e devolve o relatório final — ou um
   * bilhete, quando o trabalho é longo demais para caber numa chamada de
   * ferramenta. Erros voltam como texto: o orquestrador precisa saber que
   * falhou para decidir o que fazer, e derrubar a ferramenta esconderia isso.
   */
  delegate(agent: string, task: string, mode: DelegationMode): Promise<string>;
  /** Troca um bilhete pelo relatório, quando ele já estiver pronto. */
  collect(ticket: string): Promise<string>;
  /** O que ainda está rodando: ticket, agente e tarefa. */
  running(): Promise<readonly RunningDelegation[]>;
}

export interface DelegationEndpoint {
  readonly url: string;
  readonly token: string;
  /** Nomes completos das ferramentas, como o CLI as chama. */
  readonly toolNames: readonly string[];
}

/** Prefixo que o Claude Code dá às ferramentas de um servidor MCP. */
const SERVER_NAME = 'prometheon';

const TOOLS = [
  {
    name: 'prometheon_list_agents',
    description:
      'List the Prometheon agents you can delegate work to. Call this before delegating so you pick an agent that exists and fits the task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'prometheon_delegate',
    description:
      'Delegate one self-contained task to another Prometheon agent and wait for its report. Use it for work that a specialist does better — research, testing, review — and keep the coordination yourself. One task per call; say exactly what you need back.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description:
            'The value of the "agent" field from prometheon_list_agents — the name alone, without the role.',
        },
        task: {
          type: 'string',
          description:
            'What the agent must do, with the context it needs. It does not see your conversation.',
        },
        mode: {
          type: 'string',
          enum: ['report', 'changes'],
          description:
            'What you want back. "report" (default): the agent researches, reads and answers in text, touching no file. "changes": the agent edits files in an isolated copy of the repository, on its own branch, and reports what it changed — use this for anything that alters code.',
        },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'prometheon_status',
    description:
      'List the delegations you started that are still running: ticket, agent and task. Call this before delegating something that might already be in progress — a task you send twice comes back twice, on two branches, and one of them is wasted.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'prometheon_collect',
    description:
      'Fetch the report of a delegation that returned a ticket instead of a report. Use it in a later turn — calling it right after delegating just waits again. The report also reaches the conversation on its own when the agent finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: {
          type: 'string',
          description: 'The ticket string returned by prometheon_delegate.',
        },
      },
      required: ['ticket'],
      additionalProperties: false,
    },
  },
] as const;

export class DelegationServer {
  private server: Server | null = null;
  private token = '';
  private port = 0;

  constructor(
    private readonly handlers: DelegationHandlers,
    private readonly logger: Logger,
  ) {}

  /** Sobe o servidor na primeira delegação e reaproveita nas seguintes. */
  async start(): Promise<DelegationEndpoint> {
    if (this.server !== null) {
      return this.endpoint();
    }

    this.token = randomBytes(24).toString('base64url');
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Porta efêmera: o sistema escolhe uma livre, e nada fica reservado
      // entre execuções. Só loopback — o servidor executa agentes.
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    this.port = typeof address === 'object' && address !== null ? address.port : 0;
    this.server = server;
    this.logger.info(`Delegação: servidor MCP em 127.0.0.1:${String(this.port)}.`);
    return this.endpoint();
  }

  private endpoint(): DelegationEndpoint {
    return {
      url: `http://127.0.0.1:${String(this.port)}/mcp`,
      token: this.token,
      toolNames: TOOLS.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`),
    };
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    // O token é o que separa "o CLI que nós chamamos" de qualquer processo
    // local que descobriu a porta.
    const authorization = request.headers['authorization'];
    if (authorization !== `Bearer ${this.token}`) {
      response.writeHead(401).end();
      return;
    }

    const body = await readBody(request);
    let rpc: { id?: unknown; method?: unknown; params?: unknown };
    try {
      rpc = JSON.parse(body) as typeof rpc;
    } catch {
      response.writeHead(400).end();
      return;
    }

    const reply = (result: unknown): void => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    };

    switch (rpc.method) {
      case 'initialize':
        reply({
          protocolVersion: protocolVersionOf(rpc.params),
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '1.0.0' },
        });
        return;

      case 'tools/list':
        reply({ tools: TOOLS });
        return;

      case 'tools/call':
        reply(await this.call(rpc.params));
        return;

      default:
        // Notificação (sem `id`) não espera resposta; método desconhecido
        // devolve vazio em vez de erro, para não derrubar a sessão do CLI.
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        reply({});
    }
  }

  private async call(params: unknown): Promise<unknown> {
    const record = isRecord(params) ? params : {};
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const args = isRecord(record['arguments']) ? record['arguments'] : {};

    try {
      if (name === 'prometheon_list_agents') {
        const agents = await this.handlers.listAgents();
        return text(
          agents.length === 0
            ? 'No other agent is available to delegate to.'
            : agents
                .map(
                  (agent) =>
                    `- agent: "${agent.name}"
  role: ${agent.role}
  use it for: ${agent.description}
  can run: ${String(agent.slots)} task(s) at a time`,
                )
                .join('\n'),
        );
      }

      if (name === 'prometheon_delegate') {
        const agent = typeof args['agent'] === 'string' ? args['agent'].trim() : '';
        const task = typeof args['task'] === 'string' ? args['task'].trim() : '';
        if (agent === '' || task === '') {
          return text('Both "agent" and "task" are required.', true);
        }
        // Ausente ou desconhecido vale por `report`: o modo que não escreve em
        // disco é o certo para errar.
        const mode: DelegationMode = args['mode'] === 'changes' ? 'changes' : 'report';
        this.logger.info(`Delegação: ${agent} recebeu uma tarefa (${mode}).`);
        return text(await this.handlers.delegate(agent, task, mode));
      }

      if (name === 'prometheon_status') {
        const running = await this.handlers.running();
        return text(
          running.length === 0
            ? 'Nothing is running. Every delegation you started has already reported back.'
            : running
                .map(
                  (item) =>
                    `- ${item.ticket} — "${item.agent}" (${item.mode}), running for ${String(item.seconds)}s: ${item.task}`,
                )
                .join('\n'),
        );
      }

      if (name === 'prometheon_collect') {
        const ticket = typeof args['ticket'] === 'string' ? args['ticket'].trim() : '';
        if (ticket === '') {
          return text('"ticket" is required.', true);
        }
        return text(await this.handlers.collect(ticket));
      }

      return text(`Unknown tool: ${name}`, true);
    } catch (error) {
      // A falha volta como conteúdo, não como erro de protocolo: o
      // orquestrador precisa poder ler o motivo e decidir o próximo passo.
      return text(error instanceof Error ? error.message : String(error), true);
    }
  }
}

function text(value: string, isError = false): unknown {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function protocolVersionOf(params: unknown): string {
  const version = isRecord(params) ? params['protocolVersion'] : undefined;
  // Ecoar a versão do cliente é o que a especificação pede quando o servidor
  // a suporta; sem ela, o padrão estável.
  return typeof version === 'string' && version !== '' ? version : '2025-06-18';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => resolve(body));
  });
}
