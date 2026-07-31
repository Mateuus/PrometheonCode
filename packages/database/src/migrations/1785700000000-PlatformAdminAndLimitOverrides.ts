// Administração da plataforma: quem opera o Hub e o teto de cada organização.
//
// Duas coisas que o schema ainda não sabia dizer:
//
// 1. **Quem cuida da plataforma.** `organization.manage` responde por quem manda
//    dentro de um tenant, e é exatamente por isso que não serve aqui: editar
//    plano é decidir o que a organização pagou para ter, e deixar isso na mão do
//    dono de cada organização é o mesmo que não ter limite. `is_platform_admin`
//    é a marca de quem opera o Hub — poucas contas, concedidas à mão.
//
// 2. **Exceção de limite por organização.** As colunas de teto ficam em `plans`,
//    e mudar lá muda para todo mundo que assinou aquele plano. Estas colunas
//    valem só para uma organização: nulo significa "vale o do plano", e é o
//    padrão de `organizations.retention_days`, que já existia com essa mesma
//    ideia. Zero continua significando "sem teto", como nas colunas de `plans`.

import type { MigrationInterface, QueryRunner } from 'typeorm';

interface ColumnAddition {
  readonly table: string;
  readonly column: string;
  readonly definition: string;
}

const ADDITIONS: ColumnAddition[] = [
  {
    table: 'users',
    column: 'is_platform_admin',
    definition: 'boolean NOT NULL DEFAULT false',
  },
  { table: 'organizations', column: 'max_members', definition: 'int NULL' },
  { table: 'organizations', column: 'max_projects', definition: 'int NULL' },
  { table: 'organizations', column: 'max_knowledge_items', definition: 'int NULL' },
  { table: 'organizations', column: 'max_agent_runs_per_month', definition: 'int NULL' },
  { table: 'organizations', column: 'max_storage_bytes', definition: 'bigint unsigned NULL' },
];

async function hasColumn(
  queryRunner: QueryRunner,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = (await queryRunner.query(
    'SELECT column_name AS column_name FROM information_schema.columns ' +
      'WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  )) as { column_name: string }[];

  return rows.length > 0;
}

async function hasIndex(queryRunner: QueryRunner, table: string, index: string): Promise<boolean> {
  const rows = (await queryRunner.query(
    'SELECT index_name AS index_name FROM information_schema.statistics ' +
      'WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, index],
  )) as { index_name: string }[];

  return rows.length > 0;
}

export class PlatformAdminAndLimitOverrides1785700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const addition of ADDITIONS) {
      // Rodar duas vezes não pode falhar: a checagem é barata e o `ADD COLUMN`
      // do MySQL não aceita `IF NOT EXISTS`.
      if (await hasColumn(queryRunner, addition.table, addition.column)) {
        continue;
      }

      await queryRunner.query(
        `ALTER TABLE \`${addition.table}\` ADD \`${addition.column}\` ${addition.definition}`,
      );
    }

    if (!(await hasIndex(queryRunner, 'users', 'idx_users_platform_admin'))) {
      await queryRunner.query(
        'CREATE INDEX `idx_users_platform_admin` ON `users` (`is_platform_admin`)',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await hasIndex(queryRunner, 'users', 'idx_users_platform_admin')) {
      await queryRunner.query('DROP INDEX `idx_users_platform_admin` ON `users`');
    }

    for (const addition of [...ADDITIONS].reverse()) {
      if (!(await hasColumn(queryRunner, addition.table, addition.column))) {
        continue;
      }

      await queryRunner.query(
        `ALTER TABLE \`${addition.table}\` DROP COLUMN \`${addition.column}\``,
      );
    }
  }
}
