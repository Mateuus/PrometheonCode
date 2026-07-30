// Migrations do Hub, na ordem em que são aplicadas.
//
// A lista é explícita em vez de um glob de arquivos: o pacote compila para ESM
// com `NodeNext`, e a varredura por caminho do TypeORM depende de `require` e de
// resolver `.js`/`.ts` conforme o processo — o que dá comportamento diferente
// entre `tsx src/…`, `node dist/…` e o Vitest. Importar cada migration deixa a
// ordem visível e o build responsável por encontrá-las.
//
// Uma migration nova entra aqui **no fim**, com carimbo maior que o da anterior.

import { BaselineSchema1785404582237 } from './1785404582237-BaselineSchema.js';

export const MIGRATIONS = [BaselineSchema1785404582237] as const;
