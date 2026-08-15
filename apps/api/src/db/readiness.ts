import type { Sql } from 'postgres';

export function createSqlReadiness(sql: Sql): () => Promise<boolean> {
  return async () => {
    await sql`select 1`;
    return true;
  };
}
