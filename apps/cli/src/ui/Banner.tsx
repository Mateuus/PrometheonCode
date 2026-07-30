import { Box, Text, useStdout } from 'ink';
import { palette, symbols, wordmarkFor } from './theme.js';

/**
 * Abertura do CLI.
 *
 * Aparece uma vez, no começo de um comando interativo. Não aparece em saída
 * canalizada nem em modo JSON: arte ASCII num log é ruído para quem for ler
 * depois, e quebra qualquer coisa que consuma a saída.
 */
export function Banner({ version, subtitle }: { version: string; subtitle?: string }) {
  const { stdout } = useStdout();
  const columns = stdout.columns;
  const art = wordmarkFor(columns);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {art === null ? (
        <Text color={palette.brand} bold>
          Prometheon
        </Text>
      ) : (
        art.map((line, index) => (
          <Text key={index} color={palette.brand} bold>
            {line}
          </Text>
        ))
      )}

      <Box marginTop={art === null ? 0 : 1}>
        <Text color={palette.muted}>
          {subtitle ?? 'Orquestração de agentes'} {symbols.bullet} v{version}
        </Text>
      </Box>
    </Box>
  );
}
