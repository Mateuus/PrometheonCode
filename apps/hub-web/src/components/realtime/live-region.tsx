'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToEvents, type RealtimeEnvelope } from '@/lib/realtime/client';
import type { RealtimeEventType } from '@/lib/api/types';

/**
 * Faz uma tela de servidor se atualizar quando um evento a torna velha.
 *
 * O dado das telas vem de Server Components, então "ao vivo" aqui é
 * `router.refresh()`: o servidor recompõe a árvore com o estado novo e o React
 * costura a diferença, sem perder foco nem posição de rolagem. É o contrário de
 * manter uma cópia do domínio no cliente — que é como duas verdades nascem.
 *
 * O evento diz **que** algo mudou, não o quê: o payload do `Docs/08` é enxuto
 * de propósito. Por isso a recarga é debounced — uma rajada de eventos vira uma
 * recarga só.
 */
export function LiveRegion({
  eventTypes,
  projectId,
  conversationId,
  debounceMs = 250,
}: {
  /** Tipos que interessam a esta tela. Vazio escuta tudo. */
  eventTypes: RealtimeEventType[];
  /** Ignora eventos de outros projetos. */
  projectId?: string | undefined;
  /** Ignora eventos de outras conversas (mensagens). */
  conversationId?: string | undefined;
  debounceMs?: number;
}) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // O array chega novo a cada render; o efeito depende do conteúdo, não da
  // referência, senão o canal seria reassinado sem parar.
  const wantedKey = eventTypes.join(',');

  useEffect(() => {
    const wanted = new Set<RealtimeEventType>(
      wantedKey === '' ? [] : (wantedKey.split(',') as RealtimeEventType[]),
    );

    const matches = (event: RealtimeEnvelope): boolean => {
      if (wanted.size > 0 && !wanted.has(event.type)) {
        return false;
      }
      if (projectId !== undefined && event.projectId !== null && event.projectId !== projectId) {
        return false;
      }
      if (conversationId !== undefined) {
        const target = event.data['conversationId'];
        if (typeof target === 'string' && target !== conversationId) {
          return false;
        }
      }
      return true;
    };

    const unsubscribe = subscribeToEvents((event) => {
      // `resync` chega quando a retomada deixou um buraco: recarregar é a única
      // resposta honesta, porque o que passou não vem mais pelo socket.
      const relevant = 'kind' in event ? event.kind === 'resync' : matches(event);
      if (!relevant) {
        return;
      }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), debounceMs);
    });

    return () => {
      unsubscribe();
      clearTimeout(timer.current);
    };
  }, [router, wantedKey, projectId, conversationId, debounceMs]);

  return null;
}
