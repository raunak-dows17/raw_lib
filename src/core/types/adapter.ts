import type { Capability } from "./capability";
import type { NormalizedQuery } from "./normalized";

export type AdapterResult<T> =
  | { kind: "items"; items: T[]; total?: number }
  | { kind: "item"; item: T | null }
  | { kind: "count"; count: number }
  | { kind: "ack"; id?: string; matched?: number };

export interface Adapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  execute<T>(query: NormalizedQuery): Promise<AdapterResult<T>>;
  connect?(): Promise<void>;
  close?(): Promise<void>;
}
