/**
 * Como uma sessão é descrita para o próprio dono.
 *
 * A lista de sessões existe para responder uma pergunta só — "eu reconheço este
 * acesso?" — e tudo que ela mostra além do necessário para isso trabalha contra
 * quem a está lendo. Quem sequestrou a sessão abre a mesma tela: um histórico de
 * endereços exatos e impressões de navegador entrega ao invasor o mapa dos
 * hábitos da vítima.
 *
 * Daí as duas funções deste arquivo. Nenhuma delas é anonimização — o dado
 * completo continua no banco, para investigação de incidente. O que elas fazem é
 * decidir o que sai pela API.
 */

/** Navegadores reconhecidos, na ordem em que precisam ser testados. */
const BROWSERS: readonly (readonly [needle: string, label: string])[] = [
  // Edge e Opera anunciam `Chrome` no próprio user agent; testar os dois antes
  // é o que impede o mundo inteiro de virar "Chrome".
  ['Edg/', 'Edge'],
  ['OPR/', 'Opera'],
  ['Firefox/', 'Firefox'],
  ['Chrome/', 'Chrome'],
  ['Safari/', 'Safari'],
];

const PLATFORMS: readonly (readonly [needle: string, label: string])[] = [
  ['Windows', 'Windows'],
  // Antes de `Mac OS X`: o iPad se anuncia como Macintosh em modo desktop.
  ['iPhone', 'iOS'],
  ['iPad', 'iPadOS'],
  ['Android', 'Android'],
  ['Mac OS X', 'macOS'],
  ['Macintosh', 'macOS'],
  ['Linux', 'Linux'],
];

/** Clientes que não são navegador e se identificam sozinhos. */
const CLIENTS: readonly (readonly [needle: string, label: string])[] = [
  ['Prometheon', 'Prometheon'],
  ['VSCode', 'VS Code'],
  ['Visual Studio Code', 'VS Code'],
  ['curl/', 'curl'],
  ['node', 'Node.js'],
];

function match(
  haystack: string,
  table: readonly (readonly [string, string])[],
): string | undefined {
  return table.find(([needle]) => haystack.includes(needle))?.[1];
}

/**
 * Rótulo legível de uma sessão.
 *
 * O nome do dispositivo registrado vence o user agent: ele foi escolhido pela
 * própria pessoa ("Notebook do trabalho") e reconhece a máquina melhor que
 * qualquer coisa que se possa deduzir de um cabeçalho.
 *
 * Sem nome de dispositivo, o que sai é o par cliente/plataforma — nunca a string
 * crua. Um user agent que não case com nada vira `null` em vez de aparecer
 * inteiro: "não sei dizer" é mais honesto, e mais seguro, que despejar a
 * impressão digital do navegador na tela.
 */
export function describeClient(
  userAgent: string | null,
  deviceName: string | null,
): string | null {
  if (deviceName !== null && deviceName.trim() !== '') {
    return deviceName.slice(0, 255);
  }

  if (userAgent === null || userAgent.trim() === '') {
    return null;
  }

  const client = match(userAgent, CLIENTS) ?? match(userAgent, BROWSERS);
  const platform = match(userAgent, PLATFORMS);

  if (client !== undefined && platform !== undefined) {
    return `${client} on ${platform}`;
  }

  return client ?? platform ?? null;
}

/**
 * Reduz o endereço à rede de origem.
 *
 * IPv4 perde o último octeto (`/24`) e IPv6 fica no `/48` — que é o bloco que um
 * provedor costuma delegar a um assinante. Nos dois casos sobra o suficiente
 * para a pessoa dizer "isto é a minha internet de casa" e não sobra o bastante
 * para seguir alguém de um acesso ao outro.
 *
 * Endereço que não se reconhece vira `null`: devolver o valor original "porque
 * não deu para truncar" é justamente o caso em que ele vazaria inteiro.
 */
export function maskIp(ip: string | null): string | null {
  if (ip === null || ip.trim() === '') {
    return null;
  }

  const value = ip.trim();

  // IPv4 puro, ou o IPv4 embrulhado que um socket dual-stack entrega
  // (`::ffff:203.0.113.9`).
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  const octets = mapped.split('.');

  if (octets.length === 4 && octets.every(isOctet)) {
    return `${octets[0] ?? ''}.${octets[1] ?? ''}.${octets[2] ?? ''}.0`;
  }

  if (value.includes(':')) {
    const groups = value.split(':').filter((group) => group !== '');

    if (groups.length === 0 || !groups.every(isHexGroup)) {
      return null;
    }

    return `${groups.slice(0, 3).join(':')}::`;
  }

  return null;
}

function isOctet(part: string): boolean {
  if (part === '' || part.length > 3 || !/^\d+$/.test(part)) {
    return false;
  }

  return Number(part) <= 255;
}

function isHexGroup(part: string): boolean {
  return /^[0-9a-fA-F]{1,4}$/.test(part);
}
