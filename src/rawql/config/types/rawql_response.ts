export type RawQlResponse<T = any> = {
  status: boolean;
  message: string;
  data: RawQlResponseData<T> | null;
  errors?: { field: string; message: string }[];
};

export type RawQlResponseData<T = any> =
  | RawQlSingleResponse<T>
  | RawQlMultipleResponse<T>
  | RawQlPaginatedResponse<T>;

export type RawQlSingleResponse<T> = {
  type: "single";
  item: T;
};

export type RawQlMultipleResponse<T> = {
  type: "multiple";
  items: T[];
};

export type RawQlPaginatedResponse<T> = {
  type: "paginated";
  items: T[];
  currentPage: number;
  nextPage?: number;
  prevPage?: number;
  hasMore: boolean;
  totalItems?: number;
  totalPages?: number;
  limit: number | 10;
};
