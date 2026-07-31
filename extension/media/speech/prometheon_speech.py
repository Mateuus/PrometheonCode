#!/usr/bin/env python3
"""
Ditado por voz do Prometheon — motor local.

Roda como processo filho da extensão e nunca abre porta de rede: os comandos
chegam por stdin e os eventos saem por stdout, uma linha JSON por vez. É o mesmo
transporte que a extensão já usa com os agentes, e evita a pergunta "quem mais
nesta rede consegue falar com o meu microfone?" — a resposta é ninguém, porque
não há com o que falar.

O áudio não sai da máquina. Isso não é um detalhe de implementação: ditar uma
mensagem de trabalho significa falar sobre código, clientes e decisões internas,
e mandar isso para um serviço de terceiros é uma escolha que ninguém fez
conscientemente ao clicar num microfone.

## Protocolo

Entra (stdin), uma linha JSON por comando:

    {"type": "start", "language": "pt"}
    {"type": "stop"}
    {"type": "cancel"}

Sai (stdout), uma linha JSON por evento:

    {"type": "ready", "model": "...", "device": "cuda", "compute": "float16"}
    {"type": "listening"}
    {"type": "speech", "active": true}
    {"type": "partial", "text": "bom dia, tudo"}
    {"type": "final", "text": "Bom dia, tudo bem?"}
    {"type": "error", "code": "...", "message": "..."}

`partial` **substitui** o texto anterior, não o continua: o modelo reconsidera
palavras já ditas à luz do que vem depois, e "ele" vira "eles" quando o plural
chega três palavras adiante. Tratar as revisões como acréscimo congelaria cada
engano no lugar.

## Como o modelo é escolhido

Não há um modelo certo — há o maior que a máquina consegue rodar mais rápido
que a fala. Medido em duas máquinas com o mesmo áudio de 42 s:

    RTX 2060 SUPER, large-v3-turbo, float16 : 0,7 s de atraso, 76 revisões
    Xeon E5-2699 v3 (16 núcleos), turbo, int8 :  20 s de atraso,  0 revisões
    Xeon E5-2699 v3 (16 núcleos), small, int8 :  19 s de atraso,  5 revisões

O que separa os dois casos não é "um pouco mais lento": sem GPU a fila de
inferência nunca esvazia, nenhuma revisão chega a ser emitida, e o texto deixa
de aparecer durante a fala. Por isso a escolha automática abaixo é conservadora
em CPU e generosa em GPU — e por isso ela olha a VRAM em vez de assumir a placa
de quem escreveu isto.
"""

import json
import os
import queue
import sys
import threading
import time
from typing import Optional


def _force_utf8_io() -> None:
    """
    Fixa a codificação da saída em UTF-8.

    O Python no Windows adota a página de código do sistema — cp1252 por aqui —
    e um caractere fora dela derruba o `write` com `UnicodeEncodeError`, no meio
    de uma transcrição. Os eventos já saem escapados em ASCII pelo `emit`, então
    isto é a segunda linha de defesa: vale para traceback, aviso de biblioteca e
    qualquer texto que não passe por lá.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


_force_utf8_io()


def _register_cuda_libraries() -> None:
    """
    Deixa o CTranslate2 encontrar cuBLAS e cuDNN.

    Elas vêm dos pacotes `nvidia-*-cu12` do pip, que as instalam dentro de
    `site-packages/nvidia/<lib>/bin` — um diretório que o carregador do sistema
    não conhece. Sem este registro a falha é tardia e confusa: o CTranslate2
    carrega, `get_cuda_device_count()` responde que há GPU, o modelo é aceito, e
    só na **primeira inferência** vem
    `Library cublas64_12.dll is not found or cannot be loaded`.

    Só faz sentido no Windows. Em Linux o carregador lê `LD_LIBRARY_PATH` na
    execução do processo e alterá-la aqui dentro já seria tarde — lá quem
    resolve é quem faz o `spawn`, antes de o Python subir.
    """
    if sys.platform != "win32":
        return

    try:
        import nvidia
    except ImportError:
        return

    # `nvidia` é um pacote de espaço de nomes (PEP 420): não tem `__init__.py`,
    # e por isso `__file__` é `None`. Os diretórios reais estão em `__path__`,
    # que pode ter mais de um quando as bibliotecas vêm de instalações
    # distintas.
    for base in getattr(nvidia, "__path__", []):
        for library in ("cublas", "cudnn", "cuda_nvrtc"):
            folder = os.path.join(base, library, "bin")

            if not os.path.isdir(folder):
                continue

            os.add_dll_directory(folder)
            # O `add_dll_directory` cobre o que o Python carrega; o PATH cobre o
            # que as próprias DLLs carregam entre si — a cuDNN procura a cuBLAS,
            # e essa busca não passa pelo diretório registrado acima.
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")


_register_cuda_libraries()

# ---------------------------------------------------------------------------
# Parâmetros do fluxo
# ---------------------------------------------------------------------------

# O `webrtcvad` aceita 8, 16, 32 ou 48 kHz e quadros de 10, 20 ou 30 ms. 16 kHz
# é também a taxa interna do Whisper, então gravar nela evita uma reamostragem.
SAMPLE_RATE = 16_000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2

# Agressividade do detector de voz, de 0 a 3. Acima de 2 ele descarta fala baixa
# e o começo das frases some; abaixo de 2, ventilador e teclado abrem enunciado
# sozinhos.
VAD_AGGRESSIVENESS = 2

# Silêncio que fecha o enunciado.
#
# 350 ms é o mesmo patamar do `endpointing_ms` que serviços de streaming usam,
# e a diferença para os 700 ms de antes é perceptível: o texto assenta na
# metade do tempo. O risco de cortar quem pensa no meio da frase é real, mas
# menor do que parece — pausa de raciocínio costuma passar de meio segundo, e
# quando corta, o enunciado seguinte simplesmente continua o texto.
END_SILENCE_MS = 350

# Voz contínua para abrir um enunciado. Filtra o estalo do clique e a batida na
# mesa, que passam pelo detector como um quadro isolado.
SPEECH_ONSET_MS = 100

# Fala nova mínima para valer uma revisão.
#
# Medido numa RTX 2060 SUPER com 42 s de fala, variando só este número:
#
#     400 ms : 100 revisões, 0,44 s entre elas, texto  2,3 s atrás da fala
#     200 ms : 193 revisões, 0,30 s entre elas, texto 16,7 s atrás da fala
#
# O segundo caso parece melhor durante a fala e é muito pior no conjunto: cada
# revisão custa uma inferência sobre o enunciado **inteiro**, que cresce, e a
# 200 ms a fila deixa de esvaziar. O atraso então não é mais o custo da última
# frase — é dívida que se acumula e nunca se paga.
#
# 300 ms é onde a revisão fica visivelmente mais frequente sem a fila virar.
MIN_NEW_SPEECH_MS = 300

# Teto de um enunciado. Quem fala sem pausa teria o buffer — e o custo de cada
# revisão — crescendo sem limite; aqui o enunciado é fechado à força e um novo
# começa, sem perder áudio.
MAX_UTTERANCE_MS = 30_000


def looks_hallucinated(text: str) -> bool:
    """
    Reconhece os dois modos de alucinação do Whisper em áudio sem fala.

    O primeiro é a **repetição**: a mesma palavra emendada dezenas de vezes,
    como "Prometheon Prometheon Prometheon". Acontece em silêncio, e a assinatura
    é um vocabulário minúsculo para um texto longo.

    O segundo é a **frase de legenda**: "Thank you.", "Obrigado pela atenção.",
    "Legendas pela comunidade". O modelo foi treinado com legendas de vídeo, e
    essas frases encerram milhares delas — em trechos sem fala ele preenche com
    o que mais viu naquela posição. São curtas e sempre as mesmas, então a lista
    fechada resolve sem risco de descartar fala de verdade.

    Fora esses dois casos o texto passa. Descartar demais é pior que deixar
    passar: perder uma frase que a pessoa realmente disse é o defeito que faz
    alguém desistir do ditado.
    """
    stripped = text.strip()

    if stripped == "":
        return True

    lowered = stripped.lower().strip(" .,!?")

    if lowered in HALLUCINATION_PHRASES:
        return True

    words = stripped.split()

    # Poucas palavras distintas num texto longo é repetição. O corte em seis
    # palavras evita reprovar respostas curtas legítimas — "sim", "pode ser".
    if len(words) >= 6 and len(set(word.lower() for word in words)) <= len(words) // 3:
        return True

    return False


# Frases que o Whisper produz em silêncio, herdadas do treino com legendas.
HALLUCINATION_PHRASES = frozenset(
    {
        "thank you",
        "thanks for watching",
        "obrigado",
        "obrigado pela atenção",
        "obrigada",
        "legendas pela comunidade amara org",
        "amara org",
        "gracias por ver el video",
        "subtítulos realizados por la comunidad de amara org",
        "tchau",
        "até a próxima",
    }
)


def emit(payload: dict) -> None:
    """
    Publica um evento.

    `ensure_ascii=True` (o padrão do `json.dumps`) não é descuido: ele escapa
    todo caractere fora do ASCII como `\\uXXXX`, e o resultado atravessa
    qualquer codificação de saída sem perder nada. Sem isso, o Python no Windows
    escreve em cp1252 e "você está" chega do outro lado como "voc� est�" — a
    transcrição sai certa do modelo e é corrompida no caminho até a tela.
    Quem desfaz o escape é o `JSON.parse` do lado da extensão, de graça.

    O `flush` é obrigatório: sem ele o Python bufferiza a saída quando ela não é
    um terminal — que é exatamente o caso aqui —, e os eventos chegariam à
    extensão em blocos, tarde, ou só quando o processo terminasse.
    """
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str) -> None:
    emit({"type": "error", "code": code, "message": message})


# ---------------------------------------------------------------------------
# Escolha de modelo e dispositivo
# ---------------------------------------------------------------------------


def detect_device() -> tuple[str, str, float]:
    """
    Descobre onde rodar e com que precisão.

    Devolve `(device, compute_type, vram_gb)`. Em CPU a VRAM é 0.

    **Só a NVIDIA acelera aqui.** O CTranslate2, que roda o modelo por baixo do
    faster-whisper, tem back-end para CUDA e mais nada nas distribuições do
    PyPI: numa Radeon ou numa Arc a resposta correta é CPU, e insistir só
    produziria erro na primeira frase. Não é uma limitação que dê para contornar
    escolhendo outra opção — é o que a biblioteca compila.

    `float16` em GPU não é só mais rápido que `int8`: as placas têm unidades
    dedicadas para ele, e forçar int8 numa GPU costuma sair mais lento. Em CPU o
    inverso vale, e por larga margem.
    """
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            vram_gb = 0.0
            try:
                import subprocess

                out = subprocess.run(
                    ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if out.returncode == 0 and out.stdout.strip():
                    vram_gb = int(out.stdout.strip().splitlines()[0]) / 1024
            except Exception:  # noqa: BLE001 — sem nvidia-smi seguimos sem saber a VRAM
                pass

            return "cuda", "float16", vram_gb
    except ImportError:
        pass

    return "cpu", "int8", 0.0


def verify_inference(model) -> Optional[str]:
    """
    Transcreve meio segundo de silêncio para provar que o caminho funciona.

    Existe porque a falha típica de GPU é **tardia e enganosa**: o CTranslate2
    carrega, `get_cuda_device_count()` responde que há placa, o modelo é aceito
    — e só na primeira frase de verdade vem `Library cublas64_12.dll is not
    found`. Sem esta prova, quem descobre é a pessoa, no meio do primeiro
    ditado, com o texto que ela acabou de falar perdido.

    Meio segundo de zeros é barato e exercita exatamente o mesmo caminho de
    inferência de uma frase real. Devolve a mensagem do erro, ou `None` quando
    passou.
    """
    import numpy as np

    try:
        segments, _info = model.transcribe(
            np.zeros(SAMPLE_RATE // 2, dtype=np.float32),
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        # O resultado é preguiçoso: sem consumir o gerador, a inferência nem
        # chega a rodar e a verificação não verificaria nada.
        list(segments)

        return None
    except Exception as error:  # noqa: BLE001 — qualquer falha aqui reprova a GPU
        return str(error)


def choose_model(device: str, vram_gb: float) -> str:
    """
    Maior modelo que a máquina roda mais rápido que a fala.

    Os cortes de VRAM têm folga de propósito: o número inclui o que a placa já
    está usando para a tela, e o VS Code com uma webview aberta não é um
    consumidor desprezível. Estourar a memória da GPU no meio de um ditado não
    degrada — quebra.
    """
    override = os.environ.get("PROMETHEON_SPEECH_MODEL")
    if override:
        return override

    if device != "cuda":
        # CPU — o caso de quem tem Radeon, Arc ou placa nenhuma. Medido num
        # Xeon de 16 núcleos, `small` ficou 19 s atrás da fala e emitiu 5
        # revisões em 42 s; `large-v3-turbo`, nenhuma. `base` é o ponto em que
        # ainda sobra folga para o texto aparecer **durante** a fala, que é a
        # razão de o ditado existir.
        #
        # Um processador recente com muitos núcleos dá conta de `small`, e quem
        # quiser trocar tem `PROMETHEON_SPEECH_MODEL`. O padrão é conservador
        # de propósito: errar para o lado do modelo grande demais entrega um
        # campo que fica vazio enquanto a pessoa fala.
        return "base"

    if vram_gb >= 6:
        return "large-v3-turbo"
    if vram_gb >= 4:
        return "medium"
    if vram_gb >= 2:
        return "small"

    # VRAM desconhecida (sem nvidia-smi) ou muito pequena: `small` cabe em
    # qualquer placa que exista hoje e ainda é rápido o bastante em GPU.
    return "small"


# ---------------------------------------------------------------------------
# Detector de atividade de voz
# ---------------------------------------------------------------------------


class VoiceActivityDetector:
    """
    Envelope do `webrtcvad` com a contagem de tempo que a sessão precisa.

    Guarda estado entre chamadas porque a decisão não é por quadro: um quadro de
    voz solto no silêncio é ruído, e um quadro mudo no meio da fala é a pausa
    entre duas palavras.
    """

    def __init__(self) -> None:
        import webrtcvad

        self._vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
        self.speech_run_ms = 0
        self.silence_run_ms = 0

    def push(self, frame: bytes) -> bool:
        try:
            voiced = self._vad.is_speech(frame, SAMPLE_RATE)
        except Exception:  # noqa: BLE001 — quadro malformado não derruba a sessão
            voiced = False

        if voiced:
            self.speech_run_ms += FRAME_MS
            self.silence_run_ms = 0
        else:
            self.silence_run_ms += FRAME_MS
            self.speech_run_ms = 0

        return voiced

    def reset(self) -> None:
        self.speech_run_ms = 0
        self.silence_run_ms = 0


# ---------------------------------------------------------------------------
# Motor
# ---------------------------------------------------------------------------


class SpeechEngine:
    """
    Captura, detecta voz e transcreve.

    A captura roda na thread do `sounddevice` e só faz uma coisa: empurrar bytes
    numa fila. Tudo o mais acontece na thread de processamento. Essa separação é
    exigência da biblioteca de áudio — bloquear o callback de captura produz
    estalos e perda de amostras, e transcrever dentro dele bloquearia por
    segundos.
    """

    def __init__(self) -> None:
        self._model = None
        self._model_name = ""
        self._device = "cpu"
        self._compute = "int8"
        self._audio: queue.Queue = queue.Queue()
        self._stream = None
        self._worker: Optional[threading.Thread] = None
        self._running = threading.Event()
        self._language: Optional[str] = None
        self._discard = False

    # -- ciclo de vida -------------------------------------------------------

    def load(self) -> bool:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            fail(
                "DEPENDENCIES_MISSING",
                "faster-whisper não está instalado no ambiente Python do ditado.",
            )
            return False

        self._device, self._compute, vram_gb = detect_device()
        fallback_reason = ""

        # Duas tentativas no máximo: a preferida e a CPU. Se a preferida já é a
        # CPU, a segunda não acontece.
        for attempt in range(2):
            self._model_name = choose_model(self._device, vram_gb)

            threads = 0
            if self._device == "cpu":
                # O padrão do faster-whisper em CPU é 4 threads, quantos núcleos
                # a máquina tenha — três quartos de um processador moderno
                # parados.
                threads = os.cpu_count() or 4

            try:
                self._model = WhisperModel(
                    self._model_name,
                    device=self._device,
                    compute_type=self._compute,
                    cpu_threads=threads,
                )
                problem = verify_inference(self._model)
            except Exception as error:  # noqa: BLE001 — tratado como reprovação abaixo
                problem = str(error)

            if problem is None:
                break

            if self._device == "cpu" or attempt == 1:
                fail("MODEL_LOAD_FAILED", f"Falha ao preparar o modelo: {problem}")
                return False

            # A GPU foi anunciada e não entregou: driver antigo, bibliotecas
            # CUDA ausentes, VRAM tomada por outro processo. Cair para CPU dá um
            # ditado mais lento, e um ditado lento é melhor que nenhum.
            fallback_reason = problem
            self._model = None
            self._device, self._compute, vram_gb = "cpu", "int8", 0.0

        payload = {
            "type": "ready",
            "model": self._model_name,
            "device": self._device,
            "compute": self._compute,
            "vramGb": round(vram_gb, 1),
        }

        if fallback_reason:
            payload["fallbackReason"] = fallback_reason

        emit(payload)
        return True

    def start(self, language: Optional[str]) -> None:
        if self._running.is_set():
            return

        try:
            import sounddevice
        except ImportError:
            fail("DEPENDENCIES_MISSING", "sounddevice não está instalado.")
            return

        self._language = None if language in (None, "", "auto") else language[:2]
        self._discard = False
        # Fila nova a cada início: o que sobrou da sessão anterior é áudio de
        # outra frase, e emendá-lo no começo desta produziria uma transcrição
        # que ninguém disse.
        self._audio = queue.Queue()

        def on_audio(indata, _frames, _time, status) -> None:
            if status:
                # Estouro de buffer acontece quando a máquina engasga. Perder
                # alguns milissegundos é melhor que travar a captura.
                pass
            self._audio.put(bytes(indata))

        try:
            self._stream = sounddevice.RawInputStream(
                samplerate=SAMPLE_RATE,
                blocksize=FRAME_SAMPLES,
                dtype="int16",
                channels=1,
                callback=on_audio,
            )
            self._stream.start()
        except Exception as error:  # noqa: BLE001 — microfone ocupado, ausente, sem permissão
            fail("MICROPHONE_FAILED", f"Não foi possível abrir o microfone: {error}")
            return

        self._running.set()
        self._worker = threading.Thread(target=self._process, daemon=True)
        self._worker.start()
        emit({"type": "listening"})

    def stop(self) -> None:
        """Encerra a captura e publica o texto do que ficou em aberto."""
        self._finish(discard=False)

    def cancel(self) -> None:
        """Encerra a captura e joga fora o que estava gravado."""
        self._finish(discard=True)

    def _finish(self, discard: bool) -> None:
        if not self._running.is_set():
            return

        self._discard = discard
        self._running.clear()

        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:  # noqa: BLE001 — fechar duas vezes não é erro que importe
                pass
            self._stream = None

        # Destrava o `get` da thread de processamento, que sem isto ficaria
        # esperando um áudio que não vem mais.
        self._audio.put(b"")

        if self._worker is not None:
            self._worker.join(timeout=60)
            self._worker = None

    # -- processamento -------------------------------------------------------

    def _process(self) -> None:
        vad = VoiceActivityDetector()
        pending = bytearray()
        utterance = bytearray()
        transcribed = 0
        speaking = False

        def close_utterance() -> None:
            nonlocal utterance, transcribed, speaking

            if speaking:
                emit({"type": "speech", "active": False})
                speaking = False

            if utterance and not self._discard:
                text = self._transcribe(bytes(utterance), beam_size=5)
                if text:
                    if looks_hallucinated(text):
                        # Enunciado que o detector de voz aceitou e o modelo não
                        # soube transcrever: tosse, porta, um trecho de silêncio.
                        # Publicá-lo poria no campo texto que ninguém disse.
                        print(f"descartado (alucinação): {text!r}", file=sys.stderr)
                    else:
                        emit({"type": "final", "text": text})

            utterance = bytearray()
            transcribed = 0
            vad.reset()

        while True:
            chunk = self._audio.get()

            if not self._running.is_set() and not chunk:
                break

            pending.extend(chunk)

            while len(pending) >= FRAME_BYTES:
                frame = bytes(pending[:FRAME_BYTES])
                del pending[:FRAME_BYTES]

                voiced = vad.push(frame)

                if not utterance:
                    if voiced and vad.speech_run_ms >= SPEECH_ONSET_MS:
                        utterance.extend(frame)
                        speaking = True
                        emit({"type": "speech", "active": True})
                    continue

                utterance.extend(frame)
                duration_ms = len(utterance) * 1000 // (SAMPLE_RATE * 2)

                if duration_ms >= MAX_UTTERANCE_MS:
                    close_utterance()
                    continue

                if not voiced and vad.silence_run_ms >= END_SILENCE_MS:
                    close_utterance()
                    continue

                pending_ms = (len(utterance) - transcribed) * 1000 // (SAMPLE_RATE * 2)
                if pending_ms >= MIN_NEW_SPEECH_MS and not self._discard:
                    transcribed = len(utterance)
                    # `beam_size=1` na revisão: ela será substituída pela
                    # próxima de qualquer jeito, e o que importa é chegar rápido
                    # à tela. O texto definitivo sai no fechamento, com busca em
                    # feixe.
                    text = self._transcribe(bytes(utterance), beam_size=1)
                    if text and not looks_hallucinated(text):
                        emit({"type": "partial", "text": text})

        # Fecha o que ficou em aberto quando o `stop` chegou no meio da frase.
        close_utterance()

    def _transcribe(self, pcm: bytes, beam_size: int) -> str:
        import numpy as np

        # O divisor é 32768 e não 32767: é o módulo do menor valor
        # representável, e usá-lo mantém o zero no zero.
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0

        try:
            segments, _info = self._model.transcribe(
                audio,
                language=self._language,
                # **Sem `initial_prompt`.** A ideia de alimentar o modelo com o
                # vocabulário do projeto — nomes de arquivo, da pasta — melhora
                # o reconhecimento de jargão e tem um efeito colateral que
                # inviabiliza a técnica aqui: em silêncio ou ruído, o Whisper
                # devolve o próprio prompt, e o campo enche de
                # "Prometheon Prometheon Prometheon". Num ditado que fica aberto
                # enquanto a pessoa pensa, isso acontece o tempo todo.
                #
                # Estes três limiares são a defesa contra alucinação em geral.
                # O do meio é o que pega repetição: texto que se repete comprime
                # muito melhor que fala real, e uma razão de compressão alta é o
                # sinal mais confiável de que o modelo entrou em laço.
                no_speech_threshold=0.6,
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                beam_size=beam_size,
                # O buffer já passou pelo `webrtcvad` e só tem fala.
                vad_filter=False,
                # Sem isto o Whisper usa o próprio texto anterior como contexto
                # e entra em laço: numa retranscrição a cada poucas centenas de
                # milissegundos, a mesma frase se repete até encher o buffer.
                condition_on_previous_text=False,
            )
            return " ".join(s.text.strip() for s in segments).strip()
        except Exception as error:  # noqa: BLE001 — uma inferência ruim não derruba a sessão
            fail("INFERENCE_FAILED", f"Falha ao transcrever: {error}")
            return ""


# ---------------------------------------------------------------------------
# Laço de comandos
# ---------------------------------------------------------------------------


def main() -> None:
    engine = SpeechEngine()

    if not engine.load():
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            command = json.loads(line)
        except json.JSONDecodeError:
            fail("BAD_COMMAND", "Comando não é JSON.")
            continue

        kind = command.get("type")

        if kind == "start":
            engine.start(command.get("language"))
        elif kind == "stop":
            engine.stop()
            # `stop()` só retorna depois que a thread de processamento fechou o
            # enunciado em aberto e publicou o `final`. Este evento é o que diz
            # à extensão que não vem mais texto — sem ele, ela teria de esperar
            # o tempo limite a cada ditado para saber que acabou.
            emit({"type": "stopped"})
        elif kind == "cancel":
            engine.cancel()
            emit({"type": "cancelled"})
        elif kind == "shutdown":
            engine.cancel()
            break
        else:
            fail("BAD_COMMAND", f"Comando desconhecido: {kind}")

    engine.cancel()


if __name__ == "__main__":
    main()
