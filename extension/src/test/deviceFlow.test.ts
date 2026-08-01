import * as assert from 'node:assert/strict';
import {
  pollDeviceToken,
  requestDeviceAuthorization,
  type DeviceIdentity,
  type HubHttp,
} from '../hub/deviceFlow';

/** Identidade que a extensão manda ao Hub, no formato do contrato público. */
const IDENTITY: DeviceIdentity = {
  deviceName: 'VS Code — teste',
  deviceKind: 'vscode',
  clientVersion: '0.0.1',
  platform: 'win32',
};

/** Hub de mentira: devolve as respostas na ordem em que forem programadas. */
function fakeHub(responses: { status: number; body: unknown }[]): HubHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    post(path) {
      calls.push(path);
      const next = responses.shift();
      if (next === undefined) {
        throw new Error(`chamada inesperada a ${path}`);
      }
      return Promise.resolve(next);
    },
  };
}

suite('Device flow do Hub', () => {
  test('pede o código e aceita a resposta do Hub', async () => {
    const hub = fakeHub([
      {
        status: 200,
        body: {
          data: {
            deviceCode: 'dev_abc',
            userCode: 'WXYZ-1234',
            verificationUri: 'https://hub.prometheoncode.xyz/device',
            verificationUriComplete: 'https://hub.prometheoncode.xyz/device?code=WXYZ-1234',
            expiresIn: 600,
            interval: 5,
          },
        },
      },
    ]);

    const authorization = await requestDeviceAuthorization(hub, IDENTITY);
    assert.equal(authorization.deviceCode, 'dev_abc');
    assert.equal(authorization.userCode, 'WXYZ-1234');
    assert.equal(authorization.expiresInSeconds, 600);
    assert.equal(hub.calls[0], '/v1/auth/device/authorize');
  });

  test('intervalo ausente ou agressivo vira o piso de cinco segundos', async () => {
    for (const interval of [undefined, 0, 1]) {
      const hub = fakeHub([
        {
          status: 200,
          body: {
            data: {
              deviceCode: 'dev_abc',
              userCode: 'WXYZ-1234',
              verificationUri: 'https://hub.example.com/device',
              ...(interval === undefined ? {} : { interval }),
            },
          },
        },
      ]);
      const authorization = await requestDeviceAuthorization(hub, IDENTITY);
      assert.equal(authorization.intervalSeconds, 5, `intervalo ${String(interval)}`);
    }
  });

  test('resposta sem código de dispositivo é recusada com erro tipado', async () => {
    const hub = fakeHub([{ status: 200, body: { data: { userCode: 'ABC' } } }]);
    await assert.rejects(
      () => requestDeviceAuthorization(hub, IDENTITY),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'hub.device-authorization-failed');
        return true;
      },
    );
  });

  test('o polling distingue os estados que o Hub reporta', async () => {
    const cases: [unknown, number, string][] = [
      [{ error: { code: 'DEVICE_AUTHORIZATION_PENDING' } }, 400, 'pending'],
      [{ error: { code: 'DEVICE_AUTHORIZATION_DENIED', message: 'Recusado.' } }, 400, 'denied'],
      [{ error: { code: 'DEVICE_REVOKED' } }, 400, 'denied'],
      [{ error: { code: 'DEVICE_CODE_EXPIRED' } }, 400, 'expired'],
      [{ error: { code: 'DEVICE_CODE_INVALID' } }, 400, 'expired'],
    ];
    for (const [body, status, expected] of cases) {
      const outcome = await pollDeviceToken(fakeHub([{ status, body }]), 'dev_abc');
      assert.equal(outcome.kind, expected);
    }
  });

  test('slow-down aumenta o intervalo, e nunca abaixo do piso', async () => {
    const outcome = await pollDeviceToken(
      fakeHub([{ status: 429, body: { error: { code: 'SLOW_DOWN' }, data: { interval: 12 } } }]),
      'dev_abc',
    );
    assert.equal(outcome.kind, 'slow-down');
    assert.equal(outcome.kind === 'slow-down' ? outcome.intervalSeconds : 0, 12);

    const floored = await pollDeviceToken(
      fakeHub([{ status: 429, body: { error: { code: 'SLOW_DOWN' }, data: { interval: 1 } } }]),
      'dev_abc',
    );
    assert.equal(floored.kind === 'slow-down' ? floored.intervalSeconds : 0, 5);
  });

  test('autorização concedida devolve a credencial com validade', async () => {
    const before = Date.now();
    const outcome = await pollDeviceToken(
      fakeHub([
        {
          status: 200,
          body: {
            data: {
              deviceToken: 'pdt_secreto',
              deviceId: 'dev_1',
              expiresAt: new Date(Date.now() + 7776000000).toISOString(),
              organizationId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
            },
          },
        },
      ]),
      'dev_abc',
    );
    assert.equal(outcome.kind, 'authorized');
    if (outcome.kind !== 'authorized') {
      return;
    }
    assert.equal(outcome.credential.token, 'pdt_secreto');
    assert.equal(outcome.credential.deviceId, 'dev_1');
    assert.ok(
      outcome.credential.expiresAt !== null && outcome.credential.expiresAt > before,
      'a validade precisa ser um instante no futuro',
    );
  });

  test('a identidade que vem com a credencial é preservada', async () => {
    // O Hub manda quem autorizou junto da credencial; é o que permite ao painel
    // dizer "conectado como fulano" sem outra chamada.
    const outcome = await pollDeviceToken(
      fakeHub([
        {
          status: 200,
          body: {
            data: {
              deviceToken: 'pdt_x',
              deviceId: 'dev_1',
              user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' },
            },
          },
        },
      ]),
      'dev_abc',
    );
    assert.equal(outcome.kind, 'authorized');
    if (outcome.kind !== 'authorized') {
      return;
    }
    assert.equal(outcome.credential.userName, 'Ada Lovelace');
    assert.equal(outcome.credential.userEmail, 'ada@example.com');
  });

  test('credencial sem validade declarada não expira sozinha', async () => {
    const outcome = await pollDeviceToken(
      fakeHub([{ status: 200, body: { data: { deviceToken: 'pdt_x', deviceId: 'dev_1' } } }]),
      'dev_abc',
    );
    assert.equal(outcome.kind === 'authorized' ? outcome.credential.expiresAt : 'erro', null);
  });

  test('data de expiração inválida vira ausência, e não NaN', async () => {
    // `Date.parse` devolve NaN em texto inválido; propagar isso faria a conta de
    // expiração comparar contra NaN e tratar a credencial como sempre válida.
    const outcome = await pollDeviceToken(
      fakeHub([
        { status: 200, body: { data: { deviceToken: 'p', deviceId: 'd', expiresAt: 'ontem' } } },
      ]),
      'dev_abc',
    );
    assert.equal(outcome.kind === 'authorized' ? outcome.credential.expiresAt : 'erro', null);
  });

  test('aprovação sem credencial no corpo é falha, não sucesso silencioso', async () => {
    await assert.rejects(
      () => pollDeviceToken(fakeHub([{ status: 200, body: { data: { deviceId: 'dev_1' } } }]), 'x'),
      (error: unknown) => {
        assert.match(String((error as Error).message), /credential/i);
        return true;
      },
    );
  });

  test('código de erro desconhecido não vira "pendente"', async () => {
    // Tratar erro desconhecido como pendente deixaria a extensão em polling
    // eterno contra um Hub que já recusou o dispositivo.
    await assert.rejects(
      () =>
        pollDeviceToken(
          fakeHub([{ status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } }]),
          'dev_abc',
        ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'hub.device-authorization-failed');
        return true;
      },
    );
  });
});
