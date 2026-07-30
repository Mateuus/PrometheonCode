import { Box, Text } from 'ink';
import { Sigil } from './Sigil.js';
import { palette, symbols } from './theme.js';

export interface HeaderInfo {
  readonly version: string;
  /** Provedor e conta em uso, quando houver. */
  readonly provider?: string | undefined;
  readonly account?: string | undefined;
  /** Pasta em que o agente vai trabalhar. */
  readonly workspace?: string | undefined;
}

/**
 * Cabeçalho de um comando interativo.
 *
 * Responde de saída às três perguntas que alguém faz antes de digitar qualquer
 * coisa: que versão é esta, com qual conta estou, e em que pasta isso vai
 * mexer. A terceira é a que evita estrago — rodar um agente com permissão de
 * edição na pasta errada é o tipo de engano que só se percebe depois.
 */
export function Header({ version, provider, account, workspace }: HeaderInfo) {
  return (
    <Box marginBottom={1}>
      <Box marginRight={2} flexShrink={0}>
        <Sigil />
      </Box>

      {/* Sem `justifyContent`: centralizar verticalmente fazia o Ink comprimir
          as linhas umas sobre as outras quando o texto era mais baixo que o
          símbolo — e a primeira delas, o nome, era a que sumia. */}
      <Box flexDirection="column">
        <Box>
          <Text color={palette.brand} bold>
            Prometheon{' '}
          </Text>
          <Text color={palette.muted}>v{version}</Text>
        </Box>

        {provider === undefined ? (
          <Text color={palette.warn}>
            {symbols.warn} nenhuma conta configurada {symbols.bullet} prometheon login
          </Text>
        ) : (
          <Box>
            <Text>{provider}</Text>
            {account === undefined ? null : (
              <Text color={palette.muted}> {symbols.bullet} {account}</Text>
            )}
          </Box>
        )}

        {workspace === undefined ? null : <Text color={palette.muted}>{workspace}</Text>}
      </Box>
    </Box>
  );
}
