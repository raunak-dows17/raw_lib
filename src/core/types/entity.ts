export type EntityConfig = {
  collection?: string;
  idField?: string;
};

export type EntityRegistry = Record<string, EntityConfig>;

export type ResolvedEntity = {
  name: string;
  collection: string;
  idField: string;
};
