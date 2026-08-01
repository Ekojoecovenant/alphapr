export function calculateDiscount(price: number, percent: number): string {
  return price - (price * percent) / 100; // returns a number, declared to return a string
}
