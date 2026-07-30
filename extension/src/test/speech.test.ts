import * as assert from 'node:assert/strict';
import type { SpeechProvider } from '../speech/types';
import { getApi, isPrometheonError } from './helpers';

const notConfigured = isPrometheonError('SpeechNotConfiguredError', 'speech.not-configured');

/** Motor de mentira, só para exercitar o ciclo start → stop → texto. */
class FakeProvider implements SpeechProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake Speech';
  available = true;
  transcript: string | null = 'ditado de teste';
  started = false;
  cancelled = false;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  stop(): Promise<string | null> {
    this.started = false;
    return Promise.resolve(this.transcript);
  }

  cancel(): Promise<void> {
    this.started = false;
    this.cancelled = true;
    return Promise.resolve();
  }
}

suite('Ditado', () => {
  test('sem motor registrado, o ditado fica indisponível e não grava nada', async () => {
    const api = await getApi();
    await api.speech.register(null);

    assert.equal(await api.speech.isAvailable(), false);
    assert.equal(api.speech.state, 'idle');
    await assert.rejects(() => api.speech.start(), notConfigured);

    await api.core.startDictation();
    const { speech } = api.core.snapshot;
    assert.equal(speech.available, false);
    assert.equal(speech.state, 'idle');
    assert.ok(speech.detail, 'a interface precisa do motivo para mostrar no botão');
  });

  test('com motor, o ciclo vai de ouvindo a texto transcrito', async () => {
    const api = await getApi();
    const provider = new FakeProvider();
    await api.speech.register(provider);

    try {
      assert.equal(await api.speech.isAvailable(), true);

      await api.speech.start();
      assert.equal(api.speech.state, 'listening');
      assert.equal(provider.started, true);

      assert.equal(await api.speech.stop(), 'ditado de teste');
      assert.equal(api.speech.state, 'idle');

      // Transcrição vazia não vira texto: não há o que inserir no rascunho.
      provider.transcript = '   ';
      await api.speech.start();
      assert.equal(await api.speech.stop(), null);
    } finally {
      await api.speech.register(null);
    }
  });

  test('motor indisponível é recusado antes de gravar', async () => {
    const api = await getApi();
    const provider = new FakeProvider();
    provider.available = false;
    await api.speech.register(provider);

    try {
      await assert.rejects(() => api.speech.start(), notConfigured);
      assert.equal(provider.started, false);
      assert.equal(api.speech.state, 'idle');
    } finally {
      await api.speech.register(null);
    }
  });

  test('cancelar descarta a gravação sem transcrever', async () => {
    const api = await getApi();
    const provider = new FakeProvider();
    await api.speech.register(provider);

    try {
      await api.speech.start();
      await api.core.cancelDictation();
      assert.equal(provider.cancelled, true);
      assert.equal(api.speech.state, 'idle');
      assert.equal(api.core.snapshot.speech.state, 'idle');
    } finally {
      await api.speech.register(null);
    }
  });
});
