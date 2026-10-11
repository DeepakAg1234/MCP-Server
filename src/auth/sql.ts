import { AsyncLocalStorage } from "node:async_hooks";

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Sql {
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  inTransaction(): boolean;
  close(): Promise<void>;
}

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export function bindSql(options: {
  queryable: Queryable;
  connect: () => Promise<Queryable & { release(): void }>;
  close: () => Promise<void>;
}): Sql {
  const current = new AsyncLocalStorage<Queryable>();
  return {
    inTransaction() {
      return current.getStore() !== undefined;
    },
    async query(text, params = []) {
      const runner = current.getStore() ?? options.queryable;
      const result = await runner.query(text, params);
      return { rows: result.rows as never, rowCount: result.rowCount ?? 0 };
    },
    async transaction(fn) {
      if (current.getStore()) return fn();
      const client = await options.connect();
      try {
        await client.query("BEGIN");
        const value = await current.run(client, fn);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The connection may already be aborted.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    close: options.close,
  };
}

export function postgresText(text: string): string {
  let index = 0;
  return text.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}
