/**
 * Parâmetros do protocolo de tempo real (`Docs/08`).
 *
 * Cada número aqui é uma garantia do documento traduzida em decisão operacional.
 * Eles ficam neste módulo, e não em `config/index.ts`, porque descrevem o
 * protocolo — quem muda um deles está mudando o que o cliente pode esperar, não
 * ajustando uma implantação.
 */

export const REALTIME_SETTINGS = {
  /**
   * Vida do token de handshake: 60 segundos.
   *
   * O token viaja na query string (nenhum navegador deixa definir header em
   * `new WebSocket(...)`), e query string vaza em log de proxy. A resposta a
   * isso é dupla: vida curta e uso único — o `jti` é queimado no Redis no
   * momento em que a conexão sobe.
   */
  tokenTtlSeconds: 60,

  /**
   * Intervalo de heartbeat anunciado no `welcome`, em milissegundos.
   *
   * O servidor manda um ping de protocolo WebSocket a cada intervalo. Qualquer
   * sinal do cliente — pong, `ping` da aplicação, `ack`, qualquer mensagem —
   * conta como vida.
   */
  heartbeatIntervalMs: 30_000,

  /**
   * Silêncio tolerado antes de a conexão ser encerrada: 2,5 intervalos.
   *
   * Menos que dois intervalos derrubaria conexão saudável que perdeu um pong;
   * muito mais faria a presença mentir por minutos, que é exatamente o defeito
   * que torna o indicador inútil.
   */
  connectionTimeoutMs: 75_000,

  /**
   * TTL da presença no Redis.
   *
   * Maior que o timeout da conexão de propósito: se a instância morrer sem
   * fechar as conexões, a presença ainda expira sozinha — ninguém depende de um
   * `finally` ter rodado. É esta linha que impede o "online para sempre".
   */
  presenceTtlMs: 90_000,

  /** Varredura que remove presença expirada e anuncia quem saiu. */
  presenceSweepIntervalMs: 15_000,

  /**
   * Janela de retomada por cursor: 15 minutos.
   *
   * Quem reconecta dentro dela recebe o que perdeu. Fora dela o servidor diz
   * `resumeGap: true` em vez de fingir que entregou tudo, e o cliente recarrega
   * o estado por REST — é o "snapshot REST após perda de janela" do `Docs/08`.
   */
  resumeWindowMs: 15 * 60_000,

  /**
   * Teto de eventos entregues na retomada.
   *
   * Passar disso também é perda de janela: entregar dez mil eventos de uma vez
   * a um cliente que ficou fora é pior para ele do que mandá-lo recarregar.
   */
  resumeMaxEvents: 500,

  /**
   * Fila de saída por conexão.
   *
   * Cliente lento não pode crescer a memória do servidor sem limite. Ao estourar
   * o teto a fila é descartada inteira, o cliente recebe `BACKPRESSURE` — que é
   * um aviso de perda de janela — e recarrega por REST.
   */
  outboundQueueLimit: 256,

  /** Bytes pendentes no socket antes de a conexão ser considerada lenta. */
  outboundBufferLimitBytes: 1_048_576,

  /**
   * Estouros de fila tolerados antes de a conexão ser encerrada.
   *
   * Um estouro é um pico; três seguidos são um cliente que não acompanha, e
   * mantê-lo conectado só desperdiça CPU nos dois lados.
   */
  maxBackpressureStrikes: 3,

  /** Teto de uma mensagem do cliente: 32 KiB. */
  maxIncomingPayloadBytes: 32_768,

  /** Mensagens do cliente por janela, para conter laço acidental. */
  incomingMessageLimit: 240,
  incomingMessageWindowMs: 60_000,

  /**
   * Reavaliação do acesso das inscrições ativas.
   *
   * Autorização conferida só no `subscribe` valeria para sempre; o `Docs/09`
   * exige que revogação alcance a credencial em uso. A cada volta as inscrições
   * são reavaliadas e a sessão é conferida contra a denylist.
   */
  accessRevalidationIntervalMs: 30_000,

  /** Inscrições simultâneas por conexão. */
  maxSubscriptions: 50,
} as const;
