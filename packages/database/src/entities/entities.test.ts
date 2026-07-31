// As entidades descrevem o schema que existe de verdade.
//
// O `synchronize` do TypeORM está desligado (e vai continuar), então nada
// obriga as entidades a acompanharem o banco: uma coluna com tipo errado ou um
// nome físico trocado só aparece quando alguma consulta falha em produção. Este
// teste fecha essa brecha comparando, contra um banco recém-migrado, o que cada
// entidade declara com o que o `information_schema` diz.
//
// O que é verificado por coluna: existência, tipo completo (`varchar(191)`,
// `enum(...)`, `datetime(3)`, `bigint unsigned`), nulabilidade e se é gerada
// pelo banco. O que não é verificado: default, porque o TypeORM guarda a forma
// declarada (`() => 'CURRENT_TIMESTAMP(3)'`) e o MySQL a normalizada — comparar
// as duas exigiria reimplementar a normalização e provaria menos que a migration
// já prova.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ENTITIES } from './index.js';
import { createDisposableDatabase, probeDatabase, type DisposableDatabase } from '../test-support.js';

const probe = await probeDatabase();
if (!probe.reachable) {
  console.warn(
    `[entities] MySQL inacessível — suíte pulada. Motivo: ${probe.reason ?? 'desconhecido'}`,
  );
}

interface InformationSchemaColumn {
  table_name: string;
  column_name: string;
  column_type: string;
  is_nullable: string;
  extra: string;
}

describe.skipIf(!probe.reachable)('entidades contra o schema real', () => {
  let temporary: DisposableDatabase;
  let columns: Map<string, InformationSchemaColumn>;

  beforeAll(async () => {
    temporary = await createDisposableDatabase('prometheon_entities_test');
    const rows: InformationSchemaColumn[] = await temporary.db.query(
      `SELECT table_name AS table_name, column_name AS column_name,
              column_type AS column_type, is_nullable AS is_nullable, extra AS extra
         FROM information_schema.columns
        WHERE table_schema = DATABASE()`,
    );
    columns = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  }, 180_000);

  afterAll(async () => {
    await temporary?.drop();
  }, 60_000);

  it('cobre todas as tabelas do banco', () => {
    const declared = new Set(
      ENTITIES.map((entity) => entity.options.tableName ?? entity.options.name),
    );
    const inDatabase = new Set(
      [...columns.values()]
        .map((column) => column.table_name)
        // Tabelas de controle do próprio TypeORM, não do domínio.
        .filter((table) => !table.startsWith('typeorm_')),
    );

    expect([...inDatabase].filter((table) => !declared.has(table)).sort()).toEqual([]);
    expect([...declared].filter((table) => !inDatabase.has(table)).sort()).toEqual([]);
  });

  it('declara cada coluna com o tipo, a nulabilidade e a geração do banco', () => {
    const problems: string[] = [];

    for (const entity of ENTITIES) {
      const table = entity.options.tableName ?? entity.options.name;

      for (const [property, options] of Object.entries(entity.options.columns)) {
        if (options === undefined) {
          continue;
        }
        const name = options.name ?? property;
        const actual = columns.get(`${table}.${name}`);

        if (actual === undefined) {
          problems.push(`${table}.${name} não existe no banco`);
          continue;
        }

        const expectedType = describeType(options);
        if (expectedType !== null && expectedType !== actual.column_type) {
          problems.push(
            `${table}.${name}: entidade declara \`${expectedType}\`, banco tem \`${actual.column_type}\``,
          );
        }

        const nullableInDatabase = actual.is_nullable === 'YES';
        const nullableInEntity = options.nullable ?? false;
        if (nullableInDatabase !== nullableInEntity && options.primary !== true) {
          problems.push(
            `${table}.${name}: entidade diz nullable=${String(nullableInEntity)}, banco diz ${String(nullableInDatabase)}`,
          );
        }

        // `DEFAULT_GENERATED` marca coluna com default expressão (as nossas em
        // `CURRENT_TIMESTAMP(3)`), não coluna gerada — só `VIRTUAL`/`STORED` são.
        const generatedInDatabase =
          actual.extra.includes('VIRTUAL GENERATED') || actual.extra.includes('STORED GENERATED');
        const generatedInEntity = options.asExpression !== undefined;
        if (generatedInDatabase !== generatedInEntity) {
          problems.push(
            `${table}.${name}: coluna gerada no banco=${String(generatedInDatabase)}, na entidade=${String(generatedInEntity)}`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

/** Reconstrói o `column_type` do MySQL a partir das opções da coluna. */
function describeType(options: {
  type: unknown;
  length?: string | number | undefined;
  precision?: number | undefined;
  unsigned?: boolean | undefined;
  enum?: unknown;
}): string | null {
  const type = String(options.type);
  const unsigned = options.unsigned === true ? ' unsigned' : '';

  switch (type) {
    case 'char':
    case 'varchar':
    case 'varbinary':
      return options.length === undefined ? null : `${type}(${String(options.length)})`;
    case 'datetime':
      return options.precision === undefined ? 'datetime' : `datetime(${String(options.precision)})`;
    case 'enum': {
      const values = options.enum;
      if (!Array.isArray(values)) {
        return null;
      }
      return `enum(${values.map((value) => `'${String(value)}'`).join(',')})`;
    }
    case 'boolean':
      return 'tinyint(1)';
    case 'int':
      return `int${unsigned}`;
    case 'bigint':
      return `bigint${unsigned}`;
    case 'smallint':
      return `smallint${unsigned}`;
    case 'text':
    case 'mediumtext':
    case 'json':
      return type;
    default:
      return null;
  }
}
