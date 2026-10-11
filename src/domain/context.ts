export const PROTOCOL_VERSION = "2026-07-28";

export type TransportName = "stdio" | "streamable-http";

export type InvocationContext = {
  operationId: string;
  tenantId: string;
  userId: string;
  transport: TransportName;
  protocolVersion: string;
};

export function invocationContext(input: {
  operationId: string;
  tenantId: string;
  userId: string;
  transport?: TransportName;
}): InvocationContext {
  return {
    operationId: input.operationId,
    tenantId: input.tenantId,
    userId: input.userId,
    transport: input.transport ?? "stdio",
    protocolVersion: PROTOCOL_VERSION,
  };
}
