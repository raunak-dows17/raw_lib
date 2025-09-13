import { RawValSchema } from "../config/types";

export default class RawValRegistry {
  private registry: Map<string, RawValSchema> = new Map();

  private makeKey(entity: string, operation: string) {
    return `${entity}:${operation}`;
  }

  register(entity: string, operation: string, schema: RawValSchema) {
    const key = this.makeKey(entity, operation);
    this.registry.set(key, schema);
  }

  get(entity: string, operation: string): RawValSchema | null {
    return this.registry.get(this.makeKey(entity, operation)) || null;
  }
}
