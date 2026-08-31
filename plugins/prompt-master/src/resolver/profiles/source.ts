export interface CustomProfileRecord { id: string; profileJson: string }

type CustomProfileSource = () => CustomProfileRecord[]

let injected: CustomProfileSource = () => []

export function setCustomProfileSource(fn: CustomProfileSource | null): void {
  injected = fn ?? (() => [])
}

export function getCustomProfileSource(): CustomProfileSource {
  return injected
}