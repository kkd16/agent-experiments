/** Standard Gamepad mapping only; held buttons and menu edges are kept separate. */
export interface PadState {
  connected: boolean
  dive: boolean
  boost: boolean
  start: boolean
  pause: boolean
  disconnected: boolean
}
export class ControllerInput {
  private index: number | null = null
  private previousDive = false
  private previousMenu = false
  read(pads: readonly (Gamepad | null)[]): PadState {
    const pad =
      pads.find(
        (item) =>
          item?.connected &&
          item.mapping === 'standard' &&
          item.index === this.index,
      ) ?? pads.find((item) => item?.connected && item.mapping === 'standard')
    const disconnected = this.index !== null && !pad
    const changed = Boolean(pad && pad.index !== this.index)
    if (changed || disconnected) {
      this.previousDive = false
      this.previousMenu = false
    }
    this.index = pad?.index ?? null
    const held = (i: number) =>
      Boolean(pad?.buttons[i]?.pressed || (pad?.buttons[i]?.value ?? 0) > 0.25)
    const dive = held(0) || held(7)
    const menu = held(9)
    const value = {
      connected: Boolean(pad),
      dive,
      boost: held(1) || held(2) || held(6),
      start: dive && !this.previousDive,
      pause: menu && !this.previousMenu,
      disconnected,
    }
    this.previousDive = dive
    this.previousMenu = menu
    return value
  }
}
