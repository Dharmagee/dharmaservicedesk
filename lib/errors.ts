export class ApiError extends Error {
  status: number;
  save?: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
