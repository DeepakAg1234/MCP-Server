import pg from "pg";
import { bindSql, type Sql } from "./sql.js";

export function createPgSql(connectionString: string): Sql {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return bindSql({
    queryable: pool,
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text, params) => client.query(text, params),
        release: () => client.release(),
      };
    },
    close: () => pool.end(),
  });
}
