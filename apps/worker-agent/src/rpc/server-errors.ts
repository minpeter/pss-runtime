export class WorkerServerBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerServerBadRequestError";
  }
}

export class WorkerServerUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerServerUpstreamError";
  }
}
