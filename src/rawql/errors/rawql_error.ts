class RawQlError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any
  ) {
    super(message);
    this.name = "RawQlError";

    Object.setPrototypeOf(this, RawQlError.prototype);
  }
}
