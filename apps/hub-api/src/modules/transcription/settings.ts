/**
 * Parâmetros do ditado por voz.
 *
 * Ficam neste módulo, e não em `config/index.ts`, pelo mesmo motivo que os do
 * tempo real: descrevem o contrato que o cliente pode esperar, não um ajuste de
 * implantação. Quem muda um número aqui está mudando o protocolo.
 */

export const TRANSCRIPTION_SETTINGS = {
  /**
   * Vida do bilhete de conexão: 60 segundos, como o do tempo real.
   *
   * Ele viaja na query string — `new WebSocket()` não aceita cabeçalho — e query
   * string aparece em log de proxy. A resposta é a mesma: vida curta e uso
   * único, com o `jti` queimado no Redis quando a conexão sobe.
   */
  ticketTtlSeconds: 60,

  /**
   * Taxa de amostragem exigida do cliente.
   *
   * É a taxa que o detector de voz do Applio aceita e a que o Whisper usa
   * internamente. Fixá-la no contrato evita uma reamostragem no servidor, que
   * seria trabalho de CPU repetido para toda conexão — o navegador já faz isso
   * de graça no `AudioWorklet`.
   */
  sampleRate: 16_000,

  /**
   * Teto de um quadro de áudio recebido do navegador.
   *
   * A 16 kHz em 16 bits, um segundo de áudio ocupa 32 KB. O cliente manda
   * blocos de ~250 ms, então 64 KB dá folga de quatro vezes e ainda barra quem
   * tenta empurrar um arquivo inteiro por aqui.
   */
  maxAudioFrameBytes: 64 * 1024,

  /**
   * Duração máxima de uma sessão de ditado.
   *
   * Não é um limite de quanto alguém pode falar, e sim de quanto uma conexão
   * esquecida pode segurar um trabalhador de inferência. Cinco minutos cobre
   * qualquer ditado de mensagem de chat com margem larga.
   */
  maxSessionMs: 5 * 60_000,

  /**
   * Silêncio total tolerado antes de encerrar.
   *
   * Distinto do teto acima: aqui é o cliente que parou de mandar áudio sem
   * fechar o socket — aba congelada, rede caída no meio. Sem isto a conexão
   * ficaria aberta até o teto de sessão.
   */
  idleTimeoutMs: 60_000,

  /**
   * Sessões simultâneas por usuário.
   *
   * Cada uma ocupa uma vaga de inferência no serviço de transcrição, que é o
   * recurso escasso. Duas abas abertas é um acidente comum e cabe; a terceira
   * é sinal de que algo não está fechando as conexões.
   */
  maxConcurrentSessionsPerUser: 2,

  /**
   * Tempo para o serviço de transcrição aceitar a conexão.
   *
   * Ele pode estar carregando os pesos do modelo quando o primeiro pedido
   * chega. Dez segundos cobre a subida sem deixar a pessoa olhando para um
   * microfone que não responde.
   */
  upstreamConnectTimeoutMs: 10_000,
} as const;

/**
 * Códigos de fechamento.
 *
 * A faixa 4000-4999 é reservada para a aplicação. Os valores repetem os do
 * tempo real de propósito: quem lê log dos dois canais não deveria ter de
 * lembrar duas tabelas.
 */
export const CLOSE_CODES = {
  /** Bilhete ausente, inválido, expirado ou já usado. */
  unauthorized: 4401,
  /** Ditado desligado, ou o serviço de transcrição fora do ar. */
  unavailable: 4503,
  /** Mensagem fora do protocolo, ou quadro de áudio acima do teto. */
  protocol: 4400,
  /** Teto de sessão, ocioso demais, ou sessões simultâneas de mais. */
  exhausted: 4429,
} as const;
