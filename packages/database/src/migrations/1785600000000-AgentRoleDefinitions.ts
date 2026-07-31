// Papéis de agente nomeados pela organização.
//
// Os sete papéis embutidos continuam sendo código — `orchestrator`, `planner`,
// `implementer`, `reviewer`, `researcher`, `tester` existem em toda instalação.
// Esta tabela guarda só os que a equipe cria, como "Gameplay PIE UE5 Test", e
// que precisam chegar a todo mundo da organização.
//
// A chave primária é `(organization_id, id)` com `id` em slug, e não um ULID: o
// identificador aparece no `.prometheon/agents/roles.yaml` do projeto e no
// perfil de cada agente em cada máquina. Um ULID ali tornaria esses arquivos
// impossíveis de revisar num diff — e revisar é justamente o que se espera de
// um arquivo que a equipe versiona.

import type { MigrationInterface, QueryRunner } from 'typeorm';

// Sem `ENGINE`/`CHARSET` explícitos, como o resto do schema: o padrão do banco
// é que vale. Fixar um collation aqui produziria colunas incompatíveis com
// `organizations.id` e a chave estrangeira abaixo seria recusada.
const STATEMENTS = [
  `CREATE TABLE \`agent_role_definitions\` (
	\`organization_id\` char(26) NOT NULL,
	\`id\` varchar(64) NOT NULL,
	\`label\` varchar(160) NOT NULL,
	\`description\` varchar(240) NOT NULL,
	\`based_on\` enum('orchestrator','planner','implementer','reviewer','researcher','tester') NOT NULL DEFAULT 'implementer',
	\`skills\` json,
	\`system_prompt\` text,
	\`created_by\` char(26),
	\`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	\`updated_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	\`version\` int NOT NULL DEFAULT 1,
	CONSTRAINT \`agent_role_definitions_id\` PRIMARY KEY(\`organization_id\`,\`id\`)
)`,
  `ALTER TABLE \`agent_role_definitions\` ADD CONSTRAINT \`agent_role_definitions_organization_id_organizations_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\`(\`id\`) ON DELETE cascade ON UPDATE no action`,
  `CREATE INDEX \`idx_agent_role_definitions_org_updated_at\` ON \`agent_role_definitions\` (\`organization_id\`,\`updated_at\`)`,
];

export class AgentRoleDefinitions1785600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rodar duas vezes não pode falhar: a tabela é nova e a checagem é barata.
    const existing = (await queryRunner.query(
      'SELECT table_name AS table_name FROM information_schema.tables ' +
        "WHERE table_schema = DATABASE() AND table_name = 'agent_role_definitions'",
    )) as { table_name: string }[];

    if (existing.length > 0) {
      return;
    }

    for (const statement of STATEMENTS) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Desfazer apaga os papéis da organização, e um agente que aponta para um
    // papel que sumiu é avisado na extensão — não reapontado em silêncio.
    await queryRunner.query('DROP TABLE IF EXISTS `agent_role_definitions`');
  }
}
