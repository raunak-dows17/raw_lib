export type RawValSchema = {
  validate: (data: any) => Promise<RawValResult> | RawValResult;
};

export type RawValResult = {
  valid: boolean;
  errors?: { field: string; message: string }[];
};
