export class AuthRequiredError extends Error {
  constructor(message = "The saved REBOKS session has expired. Run `npm run login` again.") {
    super(message);
    this.name = "AuthRequiredError";
    this.code = "AUTH_REQUIRED";
  }
}

export class BookingFlowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BookingFlowError";
    this.code = "BOOKING_FLOW_ERROR";
    this.details = details;
  }
}
