'use client';

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { CloudOff, RefreshCw, Wifi } from 'lucide-react';
import { useTranslate } from '@/i18n/provider';
import { cn } from '@/lib/cn';

/**
 * Estado 6 de 7 — reconectando —, mais o offline do ponto de vista do canal ao
 * vivo.
 *
 * PROVISÓRIO na origem do sinal: hoje ele vem dos eventos `online`/`offline` do
 * navegador. Quando o WebSocket versionado do `Docs/05` existir, é esta store
 * que passa a refletir o socket; nenhuma tela muda, porque todas leem daqui.
 *
 * A conexão é um sistema externo ao React, então ela vive numa store lida por
 * `useSyncExternalStore`. Não é preciosismo: `setState` dentro de efeito para
 * espelhar `navigator.onLine` gera renderização em cascata e, no servidor, um
 * primeiro quadro que discorda do cliente.
 */

export type ConnectionStatus = 'online' | 'offline' | 'reconnecting';

interface ConnectionValue {
  status: ConnectionStatus;
  attempt: number;
}

/** Tempo que a interface passa em "reconectando" ao voltar de um corte. */
const RECONNECT_SETTLE_MS = 1_500;

const SERVER_SNAPSHOT: ConnectionValue = { status: 'online', attempt: 0 };

let snapshot: ConnectionValue = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function publish(next: ConnectionValue): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function handleOffline(): void {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }
  publish({ status: 'offline', attempt: 0 });
}

function handleOnline(): void {
  publish({ status: 'reconnecting', attempt: snapshot.attempt + 1 });
  settleTimer = setTimeout(() => publish({ status: 'online', attempt: 0 }), RECONNECT_SETTLE_MS);
}

function subscribe(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);

  if (first) {
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    if (!navigator.onLine) {
      publish({ status: 'offline', attempt: 0 });
    }
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    }
  };
}

function getSnapshot(): ConnectionValue {
  return snapshot;
}

function getServerSnapshot(): ConnectionValue {
  return SERVER_SNAPSHOT;
}

const ConnectionContext = createContext<ConnectionValue>(SERVER_SNAPSHOT);

export function ConnectionProvider({
  children,
  forced,
}: {
  children: ReactNode;
  /** Estado imposto pela URL, para revisar a tela sem derrubar a rede. */
  forced?: ConnectionStatus | undefined;
}) {
  const live = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const value = useMemo<ConnectionValue>(
    () => (forced ? { status: forced, attempt: forced === 'reconnecting' ? 1 : 0 } : live),
    [forced, live],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
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
