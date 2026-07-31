import type {
  AgentAutonomyMode,
  AgentProfile,
  CustomAgentRole,
  SkillRiskLevel,
  SkillSummary,
} from '../core/types';
import { estimateTokens, promptDescription } from './frontmatter';

/** Teto do índice por agente. Acima disso, categorias caem para só os nomes. */
export const MAX_INDEX_TOKENS = 4_000;

const RISK_ORDER: readonly SkillRiskLevel[] = ['none', 'low', 'medium', 'high'];

export interface SkillSelection {
  /** Skills que este agente enxerga no índice, na ordem em que serão listadas. */
  readonly indexed: readonly SkillSummary[];
  /** Subconjunto que ele pode de fato carregar o corpo. */
  readonly loadable: readonly SkillSummary[];
  /** Skills pedidas pelo perfil ou pelo papel que não existem no catálogo. */
  readonly missing: readonly string[];
}

/**
 * Quais skills um agente vê e quais ele pode carregar.
 *
 * A distinção é a que evita pagar contexto à toa: o orquestrador precisa
 * **saber** que uma capacidade existe para delegá-la, mas não precisa carregar
 * o procedimento — quem executa é outro agente.
 */
export function selectSkills(
  profile: AgentProfile,
  role: CustomAgentRole | null,
  catalog: readonly SkillSummary[],
  /**
   * O run pode delegar de fato. Só então vale mostrar o catálogo inteiro ao
   * orquestrador: fora do modo de equipe, listar o que ele não pode executar
   * nem entregar a ninguém é contexto pago por uma capacidade que não existe
   * naquele run.
   */
  canDelegate = false,
): SkillSelection {
  // Só o que está gravado: as skills do papel nomeado mais as do próprio
  // agente. `DEFAULT_ROLE_SKILLS` é sugestão da interface no momento de criar o
  // perfil — somá-la aqui devolveria ao agente a skill que alguém tirou dele de
  // propósito, e a remoção não surtiria efeito nenhum.
  const wanted = [...(role?.skills ?? []), ...profile.skills];
  const byName = new Map(catalog.map((skill) => [skill.name, skill]));

  const loadable: SkillSummary[] = [];
  const missing: string[] = [];
  const chosen = new Set<string>();
  for (const name of wanted) {
    if (chosen.has(name)) {
      continue;
    }
    chosen.add(name);
    const skill = byName.get(name);
    if (skill === undefined) {
      missing.push(name);
      continue;
    }
    // Plataforma é gate duro: oferecer uma skill que não roda aqui só produz
    // uma tentativa que falha no meio da tarefa.
    if (skill.supported) {
      loadable.push(skill);
    }
  }

  // O orquestrador enxerga o catálogo inteiro porque é ele quem decide a quem
  // delegar; os demais só veem o que podem executar.
  const orchestrates = profile.role === 'orchestrator' || role?.basedOn === 'orchestrator';
  const indexed =
    orchestrates && canDelegate ? catalog.filter((skill) => skill.supported) : loadable;

  return { indexed, loadable, missing };
}

/**
 * Autonomia com que o agente roda depois de carregar estas skills.
 *
 * Uma skill nunca amplia a autonomia do perfil — no máximo a restringe. É o
 * que faz `handles_secrets: true` valer mesmo num agente em bypass: o teto
 * mais apertado entre o perfil e as skills carregadas é que vale.
 */
export function effectiveAutonomy(
  profile: AgentProfile,
  loaded: readonly SkillSummary[],
): AgentAutonomyMode {
  const order: readonly AgentAutonomyMode[] = ['manual', 'auto', 'bypass-temporary'];
  let index = order.indexOf(profile.autonomyMode);
  for (const skill of loaded) {
    index = Math.min(index, order.indexOf(skill.autonomyCeiling));
  }
  return order[Math.max(index, 0)] ?? 'manual';
}

/**
 * Bloco `<available_skills>` do system prompt.
 *
 * Regra dura do estudo (§10.5, invariante 3): nenhum nome de skill habilitada
 * pode sumir do índice. Quando o orçamento aperta, a descrição é que cai —
 * porque um agente que não sabe que a capacidade existe não pede por ela, e o
 * sintoma disso é indistinguível de a skill não estar instalada.
 */
export function buildSkillIndex(
  selection: SkillSelection,
  maxTokens = MAX_INDEX_TOKENS,
): string {
  if (selection.indexed.length === 0) {
    return '';
  }

  const loadable = new Set(selection.loadable.map((skill) => skill.name));
  const full = render(selection.indexed, loadable, true);
  if (estimateTokens(full) <= maxTokens) {
    return full;
  }
  return render(selection.indexed, loadable, false);
}

function render(
  skills: readonly SkillSummary[],
  loadable: ReadonlySet<string>,
  withDescription: boolean,
): string {
  const byCategory = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    const bucket = byCategory.get(skill.category) ?? [];
    bucket.push(skill);
    byCategory.set(skill.category, bucket);
  }

  const lines: string[] = ['<available_skills>'];
  for (const category of [...byCategory.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    lines.push(`## ${category}`);
    for (const skill of byCategory.get(category) ?? []) {
      const mine = loadable.has(skill.name);
      const description = withDescription ? `: ${promptDescription(skill.description)}` : '';
      // O caminho vai junto porque é assim que a skill é lida de verdade: com a
      // ferramenta de leitura que o agente já tem. O índice não pode citar uma
      // função de carga que não existe em CLI nenhum — o agente tentaria chamá-la
      // e desistiria da skill achando que ela falhou.
      lines.push(mine ? `* ${skill.name}${description} → ${skill.path}` : `- ${skill.name}${description}`);
    }
  }
  lines.push('</available_skills>');
  lines.push(
    'A skill is a procedure to follow, not reference material. Before doing work a * skill covers, read its file and follow it; the file points to references/ for the parts it does not inline.',
  );
  // A linha sobre delegar só aparece quando há o que delegar. Dizê-la sempre
  // ensinaria o agente a esperar uma capacidade que aquele run não tem.
  if (skills.some((skill) => !loadable.has(skill.name))) {
    lines.push('Entries marked - are not yours to run — delegate them to an agent that has them.');
  }
  return lines.join('\n');
}

/** Ordena por risco crescente: o mais seguro primeiro, quando há empate. */
export function compareRisk(a: SkillRiskLevel, b: SkillRiskLevel): number {
  return RISK_ORDER.indexOf(a) - RISK_ORDER.indexOf(b);
}
