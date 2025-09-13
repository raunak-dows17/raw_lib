import { RawValResult } from "../config/types";
import RawValRegistry from "./registry";

export default class RawValEngine {
  private registry: RawValRegistry;

  constructor(registry: RawValRegistry) {
    this.registry = registry;
  }

  async validate(
    entity: string,
    operation: string,
    data: any
  ): Promise<RawValResult> {
    const schema = this.registry.get(entity, operation);

    if (!schema) {
      return { valid: true };
    }
    return schema.validate(data);
  }
}
