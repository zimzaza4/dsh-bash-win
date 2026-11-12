export class HarnessError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}
