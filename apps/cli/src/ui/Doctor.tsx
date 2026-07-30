import { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { runDoctor, type CheckResult } from '../doctor.js';
import { Banner } from './Banner.js';
import { Check, type CheckItem } from './Check.js';
import { palette, symbols } from './theme.js';

/** As verificações na ordem em que aparecem, antes de qualquer resposta. */
const PLANNED: readonly { id: string; label: string }[] = [
  { id: 'node', label: 'Node.js' },
  { id: 'claude-code', label: 'Claude Code CLI' },
  { id: 'profiles', label: 'Contas de provedor' },
  { id: 'terminal', label: 'Terminal' },
];

/**
 * Diagnóstico do ambiente.
 *
 * A lista aparece inteira desde o primeiro instante, com tudo pendente, e cada
 * linha se resolve conforme a resposta chega. Mostrar só o que já terminou faria
 * a tela crescer aos saltos e esconderia quanto ainda falta.
 */
export function Doctor({ version }: { version: string }) {
  const { exit } = useApp();
  const [results, setResults] = useState<readonly CheckResult[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;

    void runDoctor().then((checks) => {
      if (!active) {
        return;
      }

      setResults(checks);
      setDone(true);

      // Sai com código de erro quando algo impede o uso: quem chamou isto de um
      // script precisa poder decidir a partir do código de saída.
      if (checks.some((check) => check.status === 'fail')) {
        process.exitCode = 1;
      }

      exit();
    });

    return () => {
      active = false;
    };
  }, [exit]);

  const items: CheckItem[] = PLANNED.map((planned) => {
    const result = results.find((candidate) => candidate.id === planned.id);

    if (result === undefined) {
      return { id: planned.id, label: planned.label, state: done ? 'pending' : 'running' };
    }

    return {
      id: result.id,
      label: result.label,
      state: result.status,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(result.fix === undefined ? {} : { fix: result.fix }),
    };
  });

  const failures = results.filter((result) => result.status === 'fail');
  const warnings = results.filter((result) => result.status === 'warn');

  return (
    <Box flexDirection="column">
      <Banner version={version} subtitle="Verificação do ambiente" />

      <Box flexDirection="column" gap={0}>
        {items.map((item) => (
          <Check key={item.id} item={item} />
        ))}
      </Box>

      {!done ? null : (
        <Box marginTop={1}>
          {failures.length > 0 ? (
            <Text color={palette.fail}>
              {symbols.fail} {failures.length} problema
              {failures.length === 1 ? '' : 's'} impede
              {failures.length === 1 ? '' : 'm'} o uso.
            </Text>
          ) : warnings.length > 0 ? (
            <Text color={palette.warn}>
              {symbols.warn} Pronto para usar, com {warnings.length} recurso
              {warnings.length === 1 ? '' : 's'} indisponíve
              {warnings.length === 1 ? 'l' : 'is'}.
            </Text>
          ) : (
            <Text color={palette.ok}>{symbols.ok} Tudo pronto.</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
