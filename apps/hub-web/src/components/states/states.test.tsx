import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CircleSlash } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { buildDictionary } from '@/i18n/dictionary';
import { I18nProvider } from '@/i18n/provider';
import { ConnectionBanner, ConnectionProvider, ConnectionIndicator } from './connection';
import { LoadingState } from './loading-state';
import { StateBlock } from './state-block';

function renderWithI18n(ui: React.ReactNode, forced?: 'offline' | 'reconnecting' | 'online') {
  return render(
    <I18nProvider locale="pt-br" dictionary={buildDictionary('pt-br')}>
      <ConnectionProvider forced={forced}>{ui}</ConnectionProvider>
    </I18nProvider>,
  );
}

describe('crachá de status', () => {
  it('sai sempre com ícone ao lado do texto', () => {
    // "Status nunca só por cor" (Docs/05) só vale se for impossível montar um
    // crachá sem forma própria — daí o ícone padrão por tom.
    const { container } = render(<StatusBadge tone="alert">Bloqueada</StatusBadge>);
    expect(screen.getByText('Bloqueada')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('aceita ícone específico do domínio', () => {
    const { container } = render(
      <StatusBadge tone="danger" icon={CircleSlash}>
        Offline
      </StatusBadge>,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('estado de carregamento', () => {
  it('anuncia que está ocupado e dá texto ao leitor de tela', () => {
    render(<LoadingState label="Carregando…" rows={2} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
  });
});

describe('bloco de estado', () => {
  it('usa role de alerta quando pedido', () => {
    render(
      <StateBlock
        icon={CircleSlash}
        role="alert"
        title="Algo deu errado"
        description="Nada foi alterado."
        detail="ID da requisição: abc"
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('ID da requisição: abc')).toBeInTheDocument();
  });
});

describe('faixa de conexão', () => {
  it('some quando a conexão está boa', () => {
    renderWithI18n(<ConnectionBanner />, 'online');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('avisa quando está offline, no idioma da requisição', () => {
    renderWithI18n(<ConnectionBanner />, 'offline');
    expect(screen.getByRole('status')).toHaveTextContent('Você está offline');
  });

  it('avisa quando está reconectando', () => {
    renderWithI18n(<ConnectionBanner />, 'reconnecting');
    expect(screen.getByRole('status')).toHaveTextContent('Reconectando…');
  });

  it('o indicador do cabeçalho nomeia o estado, não só pinta', () => {
    renderWithI18n(<ConnectionIndicator />, 'offline');
    expect(screen.getByLabelText('Estado da conexão: Offline')).toBeInTheDocument();
  });
});
