import { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import {
  pollDeviceFlow,
  saveCredential,
  startDeviceFlow,
  type DeviceAuthorization,
} from '../hub.js';
import { Header } from './Header.js';
import { palette, symbols } from './theme.js';

type Phase =
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting'; readonly authorization: DeviceAuthorization }
  | { readonly kind: 'done'; readonly name: string; readonly email: string }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Entrada no Hub pelo device flow.
 *
 * O terminal não recebe senha nenhuma: ele mostra um código, a pessoa confirma
 * no navegador — onde já está autenticada — e o Hub emite uma credencial para
 * este dispositivo. Digitar senha num terminal a deixa no histórico do shell e
 * à vista de quem estiver olhando a tela.
 *
 * O código curto aparece em destaque porque é o que a pessoa vai conferir na
 * página: o navegador mostra o mesmo código, e conferir é o que impede alguém
 * de aprovar por engano uma autorização que outra pessoa iniciou.
 */
export function Login({ version, url }: { version: string; url: string }) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });

  useEffect(() => {
    // `AbortController` em vez de uma variável booleana: o TypeScript não enxerga
    // a mutação de uma flag através de closures assíncronos e trata a guarda como
    // sempre falsa. O sinal também é o mecanismo próprio para isto.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    void (async () => {
      try {
        const authorization = await startDeviceFlow(url);

        if (controller.signal.aborted) {
          return;
        }

        setPhase({ kind: 'waiting', authorization });

        const deadline = Date.now() + authorization.expiresIn * 1_000;
        let interval = authorization.interval;

        const attempt = async (): Promise<void> => {
          if (controller.signal.aborted) {
            return;
          }

          if (Date.now() > deadline) {
            setPhase({ kind: 'failed', reason: 'O código expirou. Rode o comando de novo.' });
            exit();
            return;
          }

          const outcome = await pollDeviceFlow(url, authorization.deviceCode);

          // A análise estática não acompanha o abort disparado pelo cleanup
          // entre uma tentativa e outra; em runtime é o que impede o login de
          // continuar depois de a tela sair.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (controller.signal.aborted) {
            return;
          }

          switch (outcome.kind) {
            case 'ready':
              await saveCredential({ url, ...outcome.credential });
              setPhase({
                kind: 'done',
                name: outcome.credential.user.name,
                email: outcome.credential.user.email,
              });
              exit();
              return;

            case 'denied':
              setPhase({ kind: 'failed', reason: 'A autorização foi negada no navegador.' });
              exit();
              return;

            case 'expired':
              setPhase({ kind: 'failed', reason: 'O código expirou. Rode o comando de novo.' });
              exit();
              return;

            case 'slow-down':
              // O Hub pediu calma: respeitar é o que evita ser barrado por
              // excesso de tentativas no meio de um login legítimo.
              interval = outcome.interval;
              break;

            default:
              break;
          }

          timer = setTimeout(() => void attempt(), interval * 1_000);
        };

        timer = setTimeout(() => void attempt(), interval * 1_000);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setPhase({
          kind: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
        exit();
      }
    })();

    return () => {
      controller.abort();

      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [url, exit]);

  return (
    <Box flexDirection="column">
      <Header version={version} />

      {phase.kind === 'starting' ? (
        <Box>
          <Text color={palette.activity}>
            <Spinner type="dots" />
          </Text>
          <Text color={palette.muted}> falando com {url}…</Text>
        </Box>
      ) : null}

      {phase.kind === 'waiting' ? (
        <Box flexDirection="column">
          <Text>Abra este endereço no navegador:</Text>
          <Box marginY={1}>
            <Text color={palette.accent}>{phase.authorization.verificationUri}</Text>
          </Box>

          <Text>E confirme que o código é este:</Text>
          <Box marginY={1}>
            <Text color={palette.brand} bold>
              {'  '}
              {phase.authorization.userCode}
            </Text>
          </Box>

          <Box>
            <Text color={palette.activity}>
              <Spinner type="dots" />
            </Text>
            <Text color={palette.muted}> esperando a confirmação…</Text>
          </Box>
        </Box>
      ) : null}

      {phase.kind === 'done' ? (
        <Text color={palette.ok}>
          {symbols.ok} Conectado como {phase.name} ({phase.email})
        </Text>
      ) : null}

      {phase.kind === 'failed' ? (
        <Text color={palette.fail}>
          {symbols.fail} {phase.reason}
        </Text>
      ) : null}
    </Box>
  );
}
