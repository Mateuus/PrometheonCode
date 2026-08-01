'use server';

import { z } from 'zod';
import { decideDevice } from '@/lib/api/commands';
import { deviceDecisionRequestSchema } from '@/lib/api/schemas';
import type { ApiFailure } from '@/lib/api/result';
import { normalizeUserCode } from '@/lib/device-code';
import { formError, formSuccess, type FormState } from './form-state';

/**
 * Decisão do device flow (`Docs/09`, passo 3b).
 *
 * A action valida com o **mesmo schema do contrato** que a API usa
 * (`deviceDecisionRequestSchema`) — não para decidir nada, e sim para apontar o
 * campo errado sem gastar uma ida à rede. Quem decide de verdade é a Hub API:
 * ela confere o código no Redis e a associação ativa com a organização.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function translateFailure(failure: ApiFailure): FormState {
  // O código vem antes do `kind`: `ORGANIZATION_ACCESS_DENIED` chega como 401
  // nesta rota (ver `apps/hub-api/src/modules/auth/routes.ts`), e cair no caso
  // genérico de "sessão expirada" mandaria a pessoa relogar sem necessidade.
  switch (failure.code) {
    case 'DEVICE_CODE_INVALID':
      return formError('device.error.invalidCode');
    case 'DEVICE_CODE_EXPIRED':
      return formError('device.error.expiredCode');
    case 'ORGANIZATION_ACCESS_DENIED':
      return formError('organizations.switchDenied');
    default:
      break;
  }

  switch (failure.kind) {
    case 'offline':
      return formError('auth.error.offline');
    case 'unauthorized':
      return formError('state.unauthorized.title');
    case 'email-unverified':
      return formError('auth.verify.requiredToWrite');
    case 'forbidden':
      return formError('state.forbidden.title');
    default:
      return formError('auth.error.generic');
  }
}

export async function decideDeviceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = deviceDecisionRequestSchema.safeParse({
    userCode: normalizeUserCode(field(formData, 'userCode')),
    decision: field(formData, 'decision'),
    organizationId: field(formData, 'organizationId'),
  });

  if (!parsed.success) {
    const issues = z.flattenError(parsed.error).fieldErrors;
    if (issues.organizationId) {
      return formError('device.error.organizationRequired', {
        organizationId: 'device.error.organizationRequired',
      });
    }
    if (issues.userCode) {
      return formError('device.error.invalidCode');
    }
    return formError('auth.error.generic');
  }

  const result = await decideDevice(parsed.data);

  if (!result.ok) {
    return translateFailure(result);
  }

  // A rota é idempotente: decidir de novo devolve o estado que **já estava**
  // gravado. Quando ele diverge da decisão enviada, alguém decidiu primeiro —
  // outra aba, outro navegador — e a mensagem certa é essa, não um falso
  // "aprovado" em cima de um pedido que na verdade foi negado.
  const expected = parsed.data.decision === 'approve' ? 'approved' : 'denied';
  if (result.data.status !== expected) {
    return formError('device.error.alreadyDecided');
  }

  // Nada de `redirect` aqui: quem conclui o fluxo é a extensão, que está em
  // polling e recolhe a credencial sozinha. O estado de sucesso diz exatamente
  // isso — voltar ao editor e, se quiser, fechar a aba.
  return formSuccess(
    result.data.status === 'approved' ? 'device.approved.title' : 'device.denied.title',
  );
}
