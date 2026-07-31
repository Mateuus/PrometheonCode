/**
 * Captura do microfone para PCM de 16 bits a 16 kHz.
 *
 * Roda num `AudioWorklet` — thread própria, fora da principal. Isso não é
 * refinamento: a conversão acontece a cada 128 amostras, e feita na thread da
 * interface ela competiria com o React a cada ~3 ms. O sintoma seria a digitação
 * engasgando justamente enquanto a transcrição escreve na tela.
 *
 * O que sai daqui é exatamente o que o serviço de transcrição espera, e a
 * conversão é feita aqui e não no servidor porque o navegador já tem o áudio em
 * mãos: mandar 48 kHz em ponto flutuante seria seis vezes mais banda para o
 * servidor jogar fora cinco sextos dela.
 */

const TARGET_SAMPLE_RATE = 16000;

// ~250 ms a 16 kHz. Blocos menores multiplicam o custo por quadro de WebSocket
// sem a transcrição ficar mais rápida — o serviço só revisa o texto a cada
// algumas centenas de milissegundos de fala nova. Maiores atrasariam a primeira
// palavra a aparecer.
const CHUNK_SAMPLES = TARGET_SAMPLE_RATE / 4;

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();

    // `sampleRate` é global dentro do worklet e vale a taxa real do contexto.
    // Pedimos 16 kHz ao criar o `AudioContext`, mas nem todo navegador atende:
    // parte deles ignora o pedido e entrega a taxa do dispositivo.
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    // Posição de leitura no fluxo de origem, em amostras fracionárias. Precisa
    // sobreviver entre chamadas de `process`: zerá-la a cada bloco introduziria
    // uma descontinuidade a cada 128 amostras, e o resultado é um chiado
    // periódico que o detector de voz confunde com fala.
    this.cursor = 0;
  }

  /**
   * Reamostra por interpolação linear e acumula até fechar um bloco.
   *
   * Interpolação linear é grosseira para música e suficiente para voz nesta
   * direção: reduzir a taxa descarta o agudo que a fala quase não usa, e o
   * modelo de transcrição trabalha em 16 kHz de qualquer maneira.
   */
  process(inputs) {
    const channel = inputs[0]?.[0];

    // Sem entrada é o normal enquanto o microfone ainda não abriu, e também
    // quando a pessoa silencia a aba. Devolver `true` mantém o nó vivo.
    if (channel === undefined) {
      return true;
    }

    while (this.cursor < channel.length) {
      const index = Math.floor(this.cursor);
      const fraction = this.cursor - index;
      const current = channel[index] ?? 0;
      const next = channel[index + 1] ?? current;
      const sample = current + (next - current) * fraction;

      // O corte antes da escala evita que um estouro na captura vire ruído de
      // alta amplitude: sem ele, um valor acima de 1 daria a volta no inteiro
      // de 16 bits e um pico positivo apareceria como estalo negativo.
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.filled] = clamped * (clamped < 0 ? 0x8000 : 0x7fff);
      this.filled += 1;

      if (this.filled === CHUNK_SAMPLES) {
        // Cópia, não referência: o buffer é reaproveitado no próximo bloco, e
        // transferir o original deixaria este processador sem onde escrever.
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }

      this.cursor += this.ratio;
    }

    // O que passou do fim deste bloco é a dívida para o próximo. Sem descontar
    // o comprimento consumido, o cursor cresceria para sempre.
    this.cursor -= channel.length;

    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
