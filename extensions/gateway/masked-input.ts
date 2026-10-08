import { Input } from "@earendil-works/pi-tui";

/** An `Input` that shows each typed character as `•`. */
export class MaskedInput extends Input {
  override render(width: number): string[] {
    const value = this.getValue();
    this.setValue("•".repeat(value.length)); // same length: the cursor stays put
    const lines = super.render(width);
    this.setValue(value);
    return lines;
  }
}
