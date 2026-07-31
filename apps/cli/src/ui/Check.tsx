import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { palette, symbols } from './theme.js';

export type CheckState = 'pending' | 'running' | 'ok' | 'warn' | 'fail';

export interface CheckItem {
  readonly id: string;
  readonly label: string;
  readonly state: CheckState;
  /** O que foi encontrado, ou o que fazer a respeito. */
  readonly detail?: string;
  /** Comando que resolve, quando existir um. */
  readonly fix?: string;
}

/**
 * Uma linha de verificação.
 *
 * O símbolo vem antes da cor de propósito. Num terminal sem cor — `NO_COLOR`,
 * saída canalizada, tema de baixo contraste — a linha continua legível, porque
 * o estado está no glifo e não no tom. Cor que carrega significado sozinha é
 * ilegível para uma parte das pessoas mesmo com o terminal colorido.
 */
export function Check({ item }: { item: CheckItem }) {
  const { icon, color } = presentation(item.state);

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={3}>
          {item.state === 'running' ? (
            <Text color={palette.activity}>
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color={color}>{icon}</Text>
          )}
        </Box>
        {/* `color` só entra quando há cor: com `exactOptionalPropertyTypes`,
            passar `undefined` é diferente de não passar. */}
        <Text {...(item.state === 'pending' ? { color: palette.muted } : {})}>{item.label}</Text>
        {item.detail === undefined ? null : (
          <Text color={palette.muted}> {symbols.line} {item.detail}</Text>
        )}
      </Box>

      {item.fix === undefined ? null : (
        <Box marginLeft={3}>
          <Text color={palette.warn}>{symbols.arrow} </Text>
          <Text color={palette.muted}>{item.fix}</Text>
        </Box>
      )}
    </Box>
  );
}

function presentation(state: CheckState): { icon: string; color: string } {
  switch (state) {
    case 'ok':
      return { icon: symbols.ok, color: palette.ok };
    case 'warn':
      return { icon: symbols.warn, color: palette.warn };
    case 'fail':
      return { icon: symbols.fail, color: palette.fail };
    case 'running':
      return { icon: symbols.pending, color: palette.activity };
    default:
      return { icon: symbols.pending, color: palette.muted };
  }
}
