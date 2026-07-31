import { useEffect, useReducer } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { AgentEvent, Autonomy, TokenUsage, WorkMode } from '@prometheon/agent-runtime';
import { runClaude } from '@prometheon/agent-runtime';
import { Header } from './Header.js';
import { palette, symbols } from './theme.js';

export interface RunOptions {
  readonly version: string;
  readonly prompt: string;
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  readonly cwd: string;
  readonly executable?: string | undefined;
  readonly configDirectory?: string | undefined;
  readonly provider?: string | undefined;
  readonly account?: string | undefined;
}

/** Uma ferramenta na linha do tempo. */
interface ToolEntry {
  readonly id: string;
  readonly tool: string;
  readonly title: string;
  readonly detail?: string;
  readonly state: 'running' | 'done' | 'failed';
}

interface RunState {
  readonly tools: readonly ToolEntry[];
  readonly text: string;
  readonly usage: TokenUsage;
  readonly thoughts: number;
  readonly status: 'working' | 'done' | 'failed' | 'cancelled';
  readonly error?: string;
}

const INITIAL: RunState = {
  tools: [],
  text: '',
  usage: { input: 0, output: 0 },
  thoughts: 0,
  status: 'working',
};

/**
 * O que aconteceu, aplicado ao que já estava na tela.
 *
 * Um redutor, e não vários `useState`: os eventos chegam em rajada, e estados
 * separados produziriam um redesenho por campo. Aqui cada evento redesenha uma
 * vez só, com tudo consistente.
 */
function reduce(state: RunState, event: AgentEvent): RunState {
  switch (event.type) {
    case 'delta':
      return { ...state, text: state.text + event.text };

    case 'tool.requested':
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            id: event.toolId,
            tool: event.tool,
            title: event.title,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
            state: 'running',
          },
        ],
      };

    case 'tool.completed':
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.id === event.toolId
            ? {
                ...tool,
                state: event.failed === true ? 'failed' : 'done',
                ...(event.detail === undefined ? {} : { detail: event.detail }),
              }
            : tool,
        ),
      };

    case 'thought':
      return { ...state, thoughts: state.thoughts + 1 };

    case 'usage':
      return {
        ...state,
        usage: {
          input: state.usage.input + event.delta.input,
          output: state.usage.output + event.delta.output,
        },
      };

    case 'completed':
      return {
        ...state,
        status: 'done',
        // O texto final do agente substitui o acumulado: os deltas já formaram
        // a mesma resposta, e concatenar mostraria tudo duas vezes.
        text: event.text === '' ? state.text : event.text,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      };

    case 'failed':
      return { ...state, status: 'failed', error: event.error.message };

    case 'cancelled':
      return { ...state, status: 'cancelled' };

    default:
      return state;
  }
}

/**
 * Execução de uma tarefa, com a linha do tempo do que o agente faz.
 *
 * O que aparece enquanto ele trabalha não é enfeite: é a diferença entre
 * esperar sem saber se algo está acontecendo e ver que arquivo está sendo
 * escrito agora — e poder interromper antes de o estrago acontecer.
 */
export function Run(options: RunOptions) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reduce, INITIAL);

  useEffect(() => {
    const controller = new AbortController();

    const run = runClaude({
      prompt: options.prompt,
      workMode: options.workMode,
      autonomy: options.autonomy,
      cwd: options.cwd,
      executable: options.executable,
      configDirectory: options.configDirectory,
      signal: controller.signal,
    });

    void (async () => {
      for await (const event of run.events) {
        // Em runtime, é o que impede um evento tardio de redesenhar uma tela
        // que já saiu.
        if (controller.signal.aborted) {
          return;
        }

        dispatch(event);
      }

      if (!controller.signal.aborted) {
        exit();
      }
    })();

    // Desmontar interrompe: o sinal chega ao processo, que recebe um pedido de
    // saída antes de ser morto. Sem isto, um agente órfão continuaria
    // trabalhando — e gastando — depois de a tela sumir.
    return () => {
      controller.abort();
    };
  }, [options, exit]);

  // Esc e Ctrl+C interrompem. O `AbortController` do efeito faz o resto: o
  // processo recebe um pedido de saída e só é morto se não obedecer.
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      exit();
    }
  });

  const working = state.status === 'working';

  return (
    <Box flexDirection="column">
      <Header
        version={options.version}
        provider={options.provider}
        account={options.account}
        workspace={options.cwd}
      />

      {state.tools.length === 0 ? null : (
        <Box flexDirection="column" marginBottom={1}>
          {state.tools.map((tool) => (
            <ToolLine key={tool.id} tool={tool} />
          ))}
        </Box>
      )}

      {state.text === '' ? null : (
        <Box marginBottom={1}>
          <Text>{state.text}</Text>
        </Box>
      )}

      <Footer state={state} working={working} />
    </Box>
  );
}

function ToolLine({ tool }: { tool: ToolEntry }) {
  const mark =
    tool.state === 'running' ? null : tool.state === 'failed' ? symbols.fail : symbols.ok;
  const color =
    tool.state === 'running'
      ? palette.running
      : tool.state === 'failed'
        ? palette.fail
        : palette.ok;

  return (
    <Box>
      <Box width={3}>
        {mark === null ? (
          <Text color={color}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={color}>{mark}</Text>
        )}
      </Box>
      <Text color={palette.accent} bold>
        {tool.tool}
      </Text>
      <Text> {tool.title}</Text>
      {tool.detail === undefined ? null : <Text color={palette.muted}> ({tool.detail})</Text>}
    </Box>
  );
}

/** Estado do run e o que ele custou. */
function Footer({ state, working }: { state: RunState; working: boolean }) {
  const tokens =
    state.usage.input === 0 && state.usage.output === 0
      ? null
      : `${state.usage.input.toLocaleString('pt-BR')} entrada ${symbols.bullet} ${state.usage.output.toLocaleString('pt-BR')} saída`;

  if (working) {
    return (
      <Box>
        <Text color={palette.activity}>
          <Spinner type="dots" />
        </Text>
        <Text color={palette.muted}>
          {' '}
          trabalhando{state.thoughts > 0 ? ` ${symbols.bullet} pensou ${state.thoughts}×` : ''}
          {tokens === null ? '' : ` ${symbols.bullet} ${tokens}`}
          {' '}
          {symbols.bullet} Esc interrompe
        </Text>
      </Box>
    );
  }

  if (state.status === 'failed') {
    return (
      <Box flexDirection="column">
        <Text color={palette.fail}>
          {symbols.fail} {state.error ?? 'O agente falhou.'}
        </Text>
      </Box>
    );
  }

  if (state.status === 'cancelled') {
    return (
      <Text color={palette.warn}>
        {symbols.warn} Interrompido.{tokens === null ? '' : ` ${tokens}`}
      </Text>
    );
  }

  return (
    <Text color={palette.muted}>
      {symbols.ok} Concluído{tokens === null ? '' : ` ${symbols.bullet} ${tokens}`}
    </Text>
  );
}
