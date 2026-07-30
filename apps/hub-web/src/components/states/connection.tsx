'use client';

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { CloudOff, RefreshCw, Wifi } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { cn } from '@/lib/cn';
import {
  connect,
  disconnect,
  getServerStatusSnapshot,
  getStatusSnapshot,
  subscribeToStatus,
  type ConnectionStatus,
  type ConnectionValue,
} from '@/lib/realtime/client';

export type { ConnectionStatus } from '@/lib/realtime/client';

/**
 * Estado 6 de 7 — reconectando —, mais o offline do ponto de vista do canal ao
 * vivo.
 *
 * O sinal vem do WebSocket de verdade (`@/lib/realtime/client`), não mais dos
 * eventos `online`/`offline` do navegador: "reconectando" agora quer dizer que
 * há uma tentativa em curso, com recuo exponencial, e "offline" quer dizer que
 * várias falharam seguidas. Nenhuma tela mudou por causa disso, porque todas
 * leem daqui.
 */

const SERVER_SNAPSHOT: ConnectionValue = { status: 'online', attempt: 0 };

const ConnectionContext = createContext<ConnectionValue>(SERVER_SNAPSHOT);

export function ConnectionProvider({
  children,
  forced,
}: {
  children: ReactNode;
  /** Estado imposto pela URL, para revisar a tela sem derrubar a rede. */
  forced?: ConnectionStatus | undefined;
}) {
  const live = useSyncExternalStore(subscribeToStatus, getStatusSnapshot, getServerStatusSnapshot);
  const value = useMemo<ConnectionValue>(
    () => (forced ? { status: forced, attempt: forced === 'reconnecting' ? 1 : 0 } : live),
    [forced, live],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/**
 * Abre o canal para uma organização. Fica no layout autenticado, porque é ali
 * que a organização já foi resolvida — e sai de cena junto com ele.
 */
export function RealtimeConnection({
  organizationId,
  projectId = null,
}: {
  organizationId: string;
  projectId?: string | null;
}) {
  useEffect(() => {
    connect({ organizationId, projectId, eventTypes: [] });
    return () => disconnect();
  }, [organizationId, projectId]);

  return null;
}

export function useConnection(): ConnectionValue {
  return useContext(ConnectionContext);
}

/** Faixa no topo do app. Some quando a conexão está boa. */
export function ConnectionBanner() {
  const { status, attempt } = useConnection();
  const t = useTranslate();

  if (status === 'online') {
    return null;
  }

  const offline = status === 'offline';
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-2 px-4 py-2 text-xs font-medium',
        offline ? 'bg-alert/15 text-foreground' : 'bg-activity/15 text-foreground',
      )}
    >
      {offline ? (
        <CloudOff aria-hidden className="size-3.5 text-alert" />
      ) : (
        <RefreshCw aria-hidden className="size-3.5 animate-spin text-activity" />
      )}
      <span>{offline ? t('state.offline.title') : t('state.reconnecting.title')}</span>
      <span className="text-muted">
        {offline ? t('state.offline.description') : t('state.reconnecting.description')}
      </span>
      {!offline && attempt > 0 ? (
        <span className="text-muted">· {t('state.reconnecting.attempt', { attempt })}</span>
      ) : null}
    </div>
  );
}

/** Indicador compacto do cabeçalho: ícone, texto e cor — nunca só cor. */
export function ConnectionIndicator({ className }: { className?: string }) {
  const { status } = useConnection();
  const t = useTranslate();

  const config = {
    online: { icon: Wifi, label: t('connection.online'), tone: 'text-activity' },
    offline: { icon: CloudOff, label: t('connection.offline'), tone: 'text-alert' },
    reconnecting: { icon: RefreshCw, label: t('connection.reconnecting'), tone: 'text-activity' },
  }[status];

  const Icon = config.icon;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs text-muted', className)}
      aria-label={`${t('connection.status')}: ${config.label}`}
    >
      <Icon
        aria-hidden
        className={cn('size-3.5', config.tone, status === 'reconnecting' && 'animate-spin')}
      />
      <span className="hidden sm:inline">{config.label}</span>
    </span>
  );
}
