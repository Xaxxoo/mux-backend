export class PaymentCompletedEvent {
  constructor(
    public readonly paymentId: string,
    public readonly walletId: string,
    public readonly amount: number,
    public readonly currency: string,
    public readonly userId: string,
    public readonly timestamp = new Date(),
  ) {}
}
