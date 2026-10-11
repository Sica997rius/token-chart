export type Turn = {
  tokens: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  model: string
  at: number
}
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'token-chart': { turns: Turn[]; limits: Limit[]; cost: number | null; cacheWeight: number; selected: string }
  }
}
