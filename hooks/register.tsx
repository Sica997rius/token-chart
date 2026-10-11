import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Turn } from '../types'

const PANE = 'token-chart'
const turns = atom({ plugin: 'token-chart', key: 'turns' } as const, [])
const limits = atom({ plugin: 'token-chart', key: 'limits' } as const, [])
const cost = atom({ plugin: 'token-chart', key: 'cost' } as const, null)

// Measured on one account (Pro plan, Oct 2026): one point of the 5-hour window was worth about 108k
// "Sonnet tokens", a Sonnet token being input + 5 x output + 1.25 x cache written + w x cache read.
// The size of a point depends on the plan (Pro, Max, Team...), so it is taken from the user's own
// crossings from the first one on and this value only fills in before that. The ratios between
// models carry over better: they keep pulling the fit until the data says otherwise.
const PRIOR_POINT = 108000
const DEFAULT_CACHE_WEIGHT = 0.03
const RATIO0: Record<string, number> = { sonnet: 1, opus: 1.5, haiku: 0.07 }
const cacheWeight = atom({ plugin: 'token-chart', key: 'cacheWeight' } as const, DEFAULT_CACHE_WEIGHT)

// The family a call is weighed under: a known one, else the word after "claude-" (a model that
// comes out later gets a weight of its own), else the id itself.
const KNOWN = ['fable', 'opus', 'sonnet', 'haiku']
const familyOf = (model: string) => {
  const m = model.toLowerCase()

  return KNOWN.find(n => m.includes(n)) ?? /claude-([a-z]+)/.exec(m)?.[1] ?? (m.slice(0, 40) || 'other')
}
const familyName = (fam: string) => `${fam.charAt(0).toUpperCase()}${fam.slice(1)}`

// Tokens of one family: [input + 5 x output + 1.25 x cache written, cache read].
type Totals = Record<string, [number, number]>
type Interval = { x: Totals; dp: number; end?: string }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const totalsOf = (v: unknown): Totals => {
  const out: Totals = {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  for (const [fam, pair] of Object.entries(v)) {
    if (Array.isArray(pair) && isNum(pair[0]) && isNum(pair[1])) out[fam] = [pair[0], pair[1]]
  }

  return out
}

const addTo = (to: Totals, fam: string, a: number, c: number) => {
  const old = to[fam] ?? [0, 0]
  to[fam] = [old[0] + a, old[1] + c]
}

// Version 1.0 kept six numbers: the three families' billable tokens, then their cache reads.
const OLD_ORDER = ['sonnet', 'opus', 'haiku']
const fromOld = (v: unknown[]): Totals => {
  const x: Totals = {}
  OLD_ORDER.forEach((fam, i) => {
    const a = Number(v[i] ?? 0)
    const c = Number(v[3 + i] ?? 0)
    if (a > 0 || c > 0) x[fam] = [a, c]
  })

  return x
}

const intervalOf = (v: unknown): Interval | null => {
  if (typeof v !== 'object' || v === null) return null
  const o = v as { x?: unknown; dp?: unknown; end?: unknown }
  if (!isNum(o.dp) || o.dp <= 0) return null
  const x = Array.isArray(o.x) ? (o.x.length === 6 ? fromOld(o.x) : {}) : totalsOf(o.x)
  if (Object.keys(x).length === 0) return null

  return typeof o.end === 'string' ? { x, dp: o.dp, end: o.end } : { x, dp: o.dp }
}

const intervalsFrom = (v: unknown) =>
  (Array.isArray(v) ? v : []).map(intervalOf).filter((x): x is Interval => x !== null)

const solve = (a: number[][], b: number[]) => {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i] ?? 0])
  for (let c = 0; c < n; c++) {
    let best = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[best]?.[c] ?? 0)) best = r
    const tmp = m[c] ?? []
    m[c] = m[best] ?? []
    m[best] = tmp
    const pivot = m[c]?.[c] ?? 0
    if (Math.abs(pivot) < 1e-12) return null
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const factor = (m[r]?.[c] ?? 0) / pivot
      for (let k = c; k <= n; k++) (m[r] as number[])[k] = (m[r]?.[k] ?? 0) - factor * (m[c]?.[k] ?? 0)
    }
  }

  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1))
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)

  return s.length ? ((s[(s.length - 1) >> 1] ?? 0) + (s[s.length >> 1] ?? 0)) / 2 : 0
}

// One point of the limit = s x ratio x r for each token of a family: s is the size of a point on
// this plan, fitted freely from the crossings with the measured ratios between models; r is how
// far this account's data moves each family from that, pulled toward 1 (firmly for a measured
// family, loosely for one never measured), since a mix of models that varies little cannot tell
// the families apart.
type Params = { s: number; r: Record<string, number>; w: number }
const LAMBDA_KNOWN = 1 / 0.7 ** 2
const LAMBDA_NEW = 1 / 3 ** 2

const pointsFor = (x: Totals, p: Params) =>
  Object.entries(x).reduce((a, [fam, [b, c]]) => a + p.s * (RATIO0[fam] ?? 1) * (p.r[fam] ?? 1) * (b + p.w * c), 0)

const solveParams = (list: Interval[], fixedW: number | null): Params => {
  const fams = [...new Set(list.flatMap(iv => Object.keys(iv.x)))]
  const p: Params = { s: 1 / PRIOR_POINT, r: Object.fromEntries(fams.map(f => [f, 1])), w: fixedW ?? DEFAULT_CACHE_WEIGHT }
  // First the size of a point, with the measured ratios as they are: the anchor of this plan.
  let uu = 0
  let uy = 0
  for (const iv of list) {
    const u = pointsFor(iv.x, { ...p, s: 1 })
    uu += u * u
    uy += u * iv.dp
  }
  if (uu > 0) p.s = uy / uu
  // Then how far each family moves from that anchor, and the weight of the cache.
  for (let iter = 0; iter < 30; iter++) {
    const gtg = fams.map(() => fams.map(() => 0))
    const gty = fams.map(() => 0)
    for (const iv of list) {
      const g = fams.map(f => {
        const [b = 0, c = 0] = iv.x[f] ?? []

        return p.s * (RATIO0[f] ?? 1) * (b + p.w * c)
      })
      for (let i = 0; i < fams.length; i++) {
        for (let j = 0; j < fams.length; j++) (gtg[i] as number[])[j] = (gtg[i]?.[j] ?? 0) + (g[i] ?? 0) * (g[j] ?? 0)
        gty[i] = (gty[i] ?? 0) + (g[i] ?? 0) * iv.dp
      }
    }
    fams.forEach((f, j) => {
      const lambda = f in RATIO0 ? LAMBDA_KNOWN : LAMBDA_NEW
      ;(gtg[j] as number[])[j] = (gtg[j]?.[j] ?? 0) + lambda
      gty[j] = (gty[j] ?? 0) + lambda
    })
    const next = solve(gtg, gty)
    if (next) p.r = Object.fromEntries(fams.map((f, j) => [f, clamp(next[j] ?? 1, 0.05, 20)]))
    if (fixedW === null) {
      let cc = 0
      let cy = 0
      for (const iv of list) {
        let billable = 0
        let cache = 0
        for (const [f, [b, c]] of Object.entries(iv.x)) {
          const theta = p.s * (RATIO0[f] ?? 1) * (p.r[f] ?? 1)
          billable += theta * b
          cache += theta * c * DEFAULT_CACHE_WEIGHT
        }
        cc += cache * cache
        cy += cache * (iv.dp - billable)
      }
      p.w = DEFAULT_CACHE_WEIGHT * clamp((cy + LAMBDA_KNOWN) / (cc + LAMBDA_KNOWN), 0.1, 10)
    }
  }

  return p
}

// What the fit says, and how sure it is. Crossings far off the fit (usage the mod did not see,
// from claude.ai, another computer or another tool) are left out of a second pass. The spread is
// the 95% error of the size of a point, from how far the crossings scatter around the fit; the
// drift compares the last DRIFT_K crossings with what the fit predicts for them.
type Fit = Params & {
  n: number
  used: number
  spread: number | null
  drift: number | null
  driftBand: number | null
}
const IV_KEEP = 600
const DRIFT_K = 10
const DRIFT_MIN_N = 30
const SPREAD0 = 87 // measured on the first 19 crossings of one account, before a fit has its own

const priorFit = (w: number | null): Fit => ({
  s: 1 / PRIOR_POINT,
  r: {},
  w: w ?? DEFAULT_CACHE_WEIGHT,
  n: 0,
  used: 0,
  spread: null,
  drift: null,
  driftBand: null,
})

const fitOf = (all: Interval[], fixedW: number | null): Fit => {
  if (all.length === 0) return priorFit(fixedW)
  let p = solveParams(all, fixedW)
  let kept = all
  // Repeated until nothing more is left out: crossings far off pull the fit toward themselves and
  // hide one another, so each pass, fitted without the previous ones, sees more of them.
  for (let pass = 0; pass < 6 && all.length >= 8; pass++) {
    const fit = p
    const res = all.map(iv => iv.dp - pointsFor(iv.x, fit))
    const inKept = (i: number) => kept.includes(all[i] as Interval)
    const cut = Math.max(1.5, 3 * 1.4826 * median(res.filter((_, i) => inKept(i)).map(Math.abs)))
    const inside = all.filter((_, i) => Math.abs(res[i] ?? 0) <= cut)
    if (inside.length < 4 || inside.length === kept.length) break
    kept = inside
    p = solveParams(kept, fixedW)
  }
  const fams = new Set(kept.flatMap(iv => Object.keys(iv.x))).size
  const dof = kept.length - fams - 2
  const preds = kept.map(iv => pointsFor(iv.x, p))
  const sigma = dof >= 3 ? Math.sqrt(kept.reduce((a, iv, i) => a + (iv.dp - (preds[i] ?? 0)) ** 2, 0) / dof) : null
  const pp = Math.sqrt(preds.reduce((a, v) => a + v * v, 0))
  const spread = sigma !== null && pp > 0 ? Math.min(100, (196 * sigma) / pp) : null
  let drift: number | null = null
  let driftBand: number | null = null
  if (all.length >= DRIFT_MIN_N && sigma !== null) {
    const recent = all.slice(-DRIFT_K)
    const predicted = recent.reduce((a, iv) => a + pointsFor(iv.x, p), 0)
    if (predicted > 0) {
      drift = recent.reduce((a, iv) => a + iv.dp, 0) / predicted - 1
      driftBand = (196 * sigma * Math.sqrt(recent.length)) / predicted
    }
  }

  return { ...p, n: all.length, used: kept.length, spread, drift, driftBand }
}

let FIT: Fit = priorFit(null)
const thetaOf = (fam: string) => FIT.s * (RATIO0[fam] ?? 1) * (FIT.r[fam] ?? 1)
const pointsOfTurn = (t: Turn, w: number) =>
  thetaOf(familyOf(t.model)) * (t.input + 5 * t.output + 1.25 * t.cacheWrite + w * t.cacheRead)
const spreadNow = () => Math.round(FIT.spread ?? Math.min(100, SPREAD0 / Math.sqrt(Math.max(1, FIT.n))))
const needFor = (target: number) =>
  FIT.spread !== null && FIT.used > 0
    ? Math.max(FIT.used, Math.ceil(FIT.used * (FIT.spread / target) ** 2))
    : Math.ceil((SPREAD0 / target) ** 2)
const isDriftAlarm = () =>
  FIT.drift !== null && FIT.driftBand !== null && Math.abs(FIT.drift * 100) > FIT.driftBand

const BLOCKS = '▁▂▃▄▅▆▇█'
const TEXT = {
  it: {
    five_hour: 'Sessione (5 ore)',
    seven_day: 'Settimana (7 giorni)',
    spend_limit: 'Limite di spesa',
    unknownReset: 'ripristino n/d',
    resetIn: 'ripristino tra',
    critical: '▲ CRITICO',
    high: '● ALTO',
    ok: '✓ OK',
    session: 'Sessione',
    command: 'Mostra a destra il grafico dei token usati',
    title: 'Token usati',
    opened: 'Pannello aperto a destra.',
    notDrawn: 'Il pannello non può essere disegnato qui:',
    summary: 'Token consumati nella finestra di 5 ore (esclusa cache letta)',
    calls: 'chiamate',
    spent: 'Spesa della sessione',
    cacheWritten: 'cache scritta',
    cacheRead: 'cache letta',
    limitsHead: "◆ LIMITI D'USO",
    noLimits: 'Nessun limite di 5 ore (API, Bedrock, Vertex o prima lettura): niente percentuali, solo token e spesa.',
    sessionCost: 'spesa sessione',
    chartHead: '◆ TOKEN · FINESTRA 5 ORE',
    noTurns: 'Nessun turno ancora.',
    used: 'consumati',
    perModel: 'per modello',
    unavailable: 'n/d',
    reliability: 'affidabilità della stima',
    drift: 'variazione recente rispetto ai pesi appresi',
    driftNone: 'variazione recente: n/d, servono almeno',
    driftChange: 'CAMBIO PROBABILE (consumo diverso dal previsto)',
    driftNoise: 'nella norma',
    needFor5: 'per ±5% servono circa',
    points: 'passaggi di punto',
    dropped: 'scartati',
    droppedWhy: 'passaggi scartati perché lontani dal resto (consumo fuori da questa installazione: claude.ai, altro PC, altro strumento?)',
    tokenUnit: 'token',
    axisY: 'token per barra (input + output + cache scritta)',
    axisX: 'meno recenti → più recenti',
    bar: 'barra',
    call: 'chiamata',
    lastCall: 'ultima chiamata',
    maxBar: 'barra massima',
    learned: 'pesi appresi',
    cacheAuto: "Peso della cache letta: appreso dall'uso",
    cacheShare: 'peso cache letta',
    prior: 'stima iniziale',
    priorNote: 'misurata su un piano Pro, si adatta al tuo dal primo passaggio di punto',
    cacheSet: 'Peso della cache letta impostato a',
    cacheBad: 'Uso: /token-chart cache <numero tra 0 e 1> | auto · /token-chart reset',
    resetDone: 'Dati della mod cancellati: si riparte dai valori iniziali.',
    estimate: 'massimo stimato',
    perPoint: 'per 1%',
  },
  en: {
    five_hour: 'Session (5 hours)',
    seven_day: 'Week (7 days)',
    spend_limit: 'Spend limit',
    unknownReset: 'reset n/a',
    resetIn: 'resets in',
    critical: '▲ CRITICAL',
    high: '● HIGH',
    ok: '✓ OK',
    session: 'Session',
    command: 'Show a side panel with token usage',
    title: 'Token usage',
    opened: 'Panel opened on the right.',
    notDrawn: 'The panel cannot be drawn here:',
    summary: 'Tokens used in the 5-hour window (cache reads excluded)',
    calls: 'calls',
    spent: 'Session cost',
    cacheWritten: 'cache written',
    cacheRead: 'cache read',
    limitsHead: '◆ USAGE LIMITS',
    noLimits: 'No 5-hour limit (API, Bedrock, Vertex or no reading yet): no percentages, tokens and cost only.',
    sessionCost: 'session cost',
    chartHead: '◆ TOKENS · 5-HOUR WINDOW',
    noTurns: 'No calls yet.',
    used: 'used',
    perModel: 'per model',
    unavailable: 'n/a',
    reliability: 'estimate reliability',
    drift: 'recent change against the learned weights',
    driftNone: 'recent change: n/a, needs at least',
    driftChange: 'LIKELY CHANGE (usage differs from what was learned)',
    driftNoise: 'within noise',
    needFor5: 'for ±5% about',
    points: 'point crossings are needed',
    dropped: 'left out',
    droppedWhy: 'crossings left out as far from the rest (usage outside this install: claude.ai, another computer, another tool?)',
    tokenUnit: 'tokens',
    axisY: 'tokens per bar (input + output + cache written)',
    axisX: 'older → newer',
    bar: 'bar',
    call: 'call',
    lastCall: 'last call',
    maxBar: 'tallest bar',
    learned: 'learned weights',
    cacheAuto: 'Cache-read weight: learned from use',
    cacheShare: 'cache-read weight',
    prior: 'initial estimate',
    priorNote: 'measured on a Pro plan, adapts to yours from the first point crossing',
    cacheSet: 'Cache-read weight set to',
    cacheBad: 'Usage: /token-chart cache <number between 0 and 1> | auto · /token-chart reset',
    resetDone: "The mod's data is cleared: back to the starting values.",
    estimate: 'estimated max',
    perPoint: 'per 1%',
  },
} as const

let lang: keyof typeof TEXT = 'it'
const t = (key: keyof (typeof TEXT)['it']) => TEXT[lang][key]
const nameOfLimit = (kind: string) =>
  kind === 'five_hour' || kind === 'seven_day' || kind === 'spend_limit' ? t(kind) : kind

const signed = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`
const driftText = () => {
  if (FIT.drift === null || FIT.driftBand === null) {
    return `${t('driftNone')} ${DRIFT_MIN_N} ${t('points')} (n=${FIT.n})`
  }
  const verdict = isDriftAlarm() ? t('driftChange') : t('driftNoise')

  return `${t('drift')} ${signed(FIT.drift)} · ${verdict} (±${Math.round(FIT.driftBand)}%)`
}
const reliabilityText = () =>
  `±${spreadNow()}% · n=${FIT.n}/${needFor(5)}${FIT.used < FIT.n ? ` · ${t('dropped')} ${FIT.n - FIT.used}` : ''}`
const fmtW = (w: number) => String(Number(w.toFixed(3)))

const CHART_ROWS = 4

const isTurn = (t: unknown): t is Turn =>
  typeof t === 'object' &&
  t !== null &&
  isNum((t as Turn).tokens) &&
  isNum((t as Turn).cacheRead) &&
  isNum((t as Turn).at) &&
  typeof (t as Turn).model === 'string'

const readTurns = async ($: EngineInterface) =>
  ((await read($, turns)) as unknown[]).filter(isTurn)

// Calls are kept for the chart of the current window only (with an hour to spare), and never more
// than MAX_TURNS: the store holds 4 MiB in all.
const KEEP_MS = 6 * 3600 * 1000
const WINDOW_MS = 5 * 3600 * 1000
const MAX_TURNS = 8000
const STALE_MS = 24 * 3600 * 1000
const prune = (list: Turn[], now: number) => list.filter(x => x.at >= now - KEEP_MS).slice(-MAX_TURNS)

// Turns that fall in the current 5-hour window; every turn while the window is unknown.
const inWindow = (list: Turn[], windows: Limit[]) => {
  const reset = windows.find(w => w.kind === 'five_hour')?.resetsAt
  const end = reset ? Date.parse(reset) : NaN

  return Number.isNaN(end) ? list : list.filter(t => t.at >= end - WINDOW_MS)
}

const money = (usd: number | null) => (usd === null ? t('unavailable') : `$${usd.toFixed(2)}`)

const sameWindow = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) < 10 * 60000

type Sum = { points: number; tokens: number; input: number; output: number; cacheWrite: number; cacheRead: number; turns: number }

// Share of the weighed consumption that comes from re-reading the cache, in percent.
const cacheShare = (list: Turn[], weight: number) => {
  const total = list.reduce((a, b) => a + pointsOfTurn(b, weight), 0)
  const cache = list.reduce((a, b) => a + thetaOf(familyOf(b.model)) * weight * b.cacheRead, 0)

  return total > 0 ? Math.round((cache / total) * 100) : 0
}

const sumByModel = (list: Turn[], w: number) => {
  const map = new Map<string, Sum>()
  for (const t of list) {
    const o = map.get(t.model) ?? { points: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, turns: 0 }
    map.set(t.model, {
      points: o.points + pointsOfTurn(t, w),
      tokens: o.tokens + t.tokens,
      input: o.input + t.input,
      output: o.output + t.output,
      cacheWrite: o.cacheWrite + t.cacheWrite,
      cacheRead: o.cacheRead + t.cacheRead,
      turns: o.turns + 1,
    })
  }

  return map
}

const FAMILIES: Record<string, string> = {
  fable: 'yellow',
  opus: 'magenta',
  sonnet: 'cyan',
  haiku: 'green',
}

const colorOf = (model: string) => FAMILIES[familyOf(model)] ?? 'suggestion'

const nameOf = (model: string) => {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  const [, name = '', major = '', minor = ''] = m ?? []

  return m ? `${name.charAt(0).toUpperCase()}${name.slice(1)} ${major}.${minor}` : model
}

const bar = (percent: number, width: number) => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return { filled: '█'.repeat(filled), empty: '░'.repeat(width - filled) }
}

const status = (percent: number) =>
  percent >= 90
    ? { color: 'error', label: t('critical') }
    : percent >= 70
      ? { color: 'warning', label: t('high') }
      : { color: 'success', label: t('ok') }

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))

const remaining = (iso: string | undefined, now: number) => {
  if (!iso) return t('unknownReset')
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  const h = Math.floor(minutes / 60)

  return `${t('resetIn')} ${h > 0 ? `${h} h ` : ''}${minutes % 60} min`
}

// The size of one point for the family of the latest call (Sonnet when there is none yet).
const estimateText = (list: Turn[]) => {
  const fam = familyOf(list[list.length - 1]?.model ?? 'sonnet')
  const per = 1 / thetaOf(fam)

  return FIT.n > 0
    ? `${t('estimate')}: ~${compact(per * 100)} ${t('tokenUnit')} ${familyName(fam)} (${compact(per)} ${t('perPoint')})`
    : `${t('prior')}: ~${compact(PRIOR_POINT)} ${t('tokenUnit')} Sonnet ${t('perPoint')} · ${t('priorNote')}`
}

// Every family the fit or the window knows, as a multiple of Sonnet.
const weightsText = (list: Turn[]) => {
  const fams = [...new Set([...Object.keys(RATIO0), ...Object.keys(FIT.r), ...list.map(x => familyOf(x.model))])]
  const others = fams
    .filter(f => f !== 'sonnet')
    .map(f => `${familyName(f)} x${(thetaOf(f) / thetaOf('sonnet')).toFixed(2)}`)

  return [`Sonnet 1% ≈ ${compact(1 / thetaOf('sonnet'))}`, ...others, `n=${FIT.n}`].join(' · ')
}

const safeSet = async ($: EngineInterface, key: string, value: unknown) => {
  try {
    await $.store.set(key, value)

    return true
  } catch {
    return false
  }
}

const refreshStatus = async ($: EngineInterface) => {
  const five = (await read($, limits)).find(l => l.kind === 'five_hour')
  $.ui.status(
    five
      ? `${t('session')} ${Math.round(five.percentUsed)}% · ${remaining(five.resetsAt, await $.clock.now())}`
      : undefined,
  )
}

let ownKey: string | undefined

// Each session adds its tokens under a key of its own, so two sessions never overwrite each
// other's running totals; a crossing is measured against the sum of all of them.
const accKey = async ($: EngineInterface) => {
  if (ownKey) return ownKey
  let id = ''
  try {
    id = await $.session.id()
  } catch {
    id = `${await $.clock.now()}`
  }
  ownKey = `acc:${id}`

  return ownKey
}

const sumAcc = async ($: EngineInterface) => {
  const sum: Totals = {}
  for (const key of await $.store.keys()) {
    if (!key.startsWith('acc:')) continue
    const v = (await $.store.get(key)) as { x?: unknown } | undefined
    for (const [fam, [a, c]] of Object.entries(totalsOf(v?.x))) addTo(sum, fam, a, c)
  }

  return sum
}

// What the fit was last computed from: the crossings and the cache-weight setting in the store.
let fitSource = ''

const refit = async ($: EngineInterface) => {
  const manual = (await $.store.get('manualCache')) === true
  const saved = await $.store.get('cacheWeight')
  const fixed = manual && isNum(saved) ? saved : null
  const raw = await $.store.get('intervals')
  const list = intervalsFrom(raw)
  FIT = fitOf(list, fixed)
  fitSource = sourceOf(raw, manual, saved)
  await update($, cacheWeight, () => FIT.w)
}

const sourceOf = (raw: unknown, manual: boolean, saved: unknown) => {
  const list = Array.isArray(raw) ? raw : []
  const last = list[list.length - 1] as { end?: unknown; dp?: unknown } | undefined

  return JSON.stringify([list.length, last?.end ?? null, last?.dp ?? null, manual, saved ?? null])
}

// Every chat shares one store: when another chat adds a crossing, or the store is rewritten, the
// fit is computed again, so all panels show the same figures.
const syncFit = async ($: EngineInterface) => {
  const manual = (await $.store.get('manualCache')) === true
  const saved = await $.store.get('cacheWeight')
  if (sourceOf(await $.store.get('intervals'), manual, saved) !== fitSource) await refit($)
}

const onTick = async ($: EngineInterface) => {
  await syncFit($)
  await refreshStatus($)
  $.ui.invalidate('ui.render')
}

// Data kept by version 1.0, and the totals of sessions gone for a day, are folded into one
// archive key: the sum stays the same, the store stays small.
const tidy = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const archive = totalsOf(((await $.store.get('acc:archive')) as { x?: unknown } | undefined)?.x)
  let changed = false
  const old = await $.store.get('acc')
  if (Array.isArray(old)) {
    for (const [fam, [a, c]] of Object.entries(fromOld(old))) addTo(archive, fam, a, c)
    await $.store.delete('acc')
    changed = true
  }
  const own = await accKey($)
  for (const key of await $.store.keys()) {
    if (!key.startsWith('acc:') || key === 'acc:archive' || key === own) continue
    const v = (await $.store.get(key)) as { at?: unknown; x?: unknown } | undefined
    if (isNum(v?.at) && v.at >= now - STALE_MS) continue
    for (const [fam, [a, c]] of Object.entries(totalsOf(v?.x))) addTo(archive, fam, a, c)
    await $.store.delete(key)
    changed = true
  }
  if (changed) await safeSet($, 'acc:archive', { x: archive })
  for (const key of ['samples', 'readings', 'learned']) {
    if ((await $.store.get(key)) !== undefined) await $.store.delete(key)
  }
  const raw = await $.store.get('intervals')
  if (Array.isArray(raw) && raw.some(v => Array.isArray((v as { x?: unknown })?.x))) {
    await safeSet($, 'intervals', intervalsFrom(raw))
  }
}

export const register: Register = (on, options) => {
  lang = options.language === 'en' ? 'en' : 'it'
  const openOnStart = options.openOnStart !== 'no'
  FIT = priorFit(null)
  fitSource = ''
  let tick: { cancel: () => void } | undefined
  ownKey = undefined

  on('session.start', async ($, e, next) => {
    // A surface that refuses the command still gets the panel and the learning.
    try {
      await $.command.register({
        name: 'token-chart',
        description: t('command'),
      })
    } catch {
      // the summary is then reached through the panel alone
    }
    const now = await $.clock.now()
    const saved = await $.store.get('turns')
    const restored = Array.isArray(saved) ? saved.filter(isTurn) : []
    await update($, turns, list => {
      const seen = new Set((list as unknown[]).filter(isTurn).map(t => `${t.at}:${t.model}:${t.tokens}`))

      return prune(
        [...restored.filter(t => !seen.has(`${t.at}:${t.model}:${t.tokens}`)), ...(list as unknown[]).filter(isTurn)].sort(
          (a, b) => a.at - b.at,
        ),
        now,
      )
    })
    await tidy($)
    await refit($)
    if (openOnStart) void $.ui.open({ id: PANE, title: t('title') })
    tick?.cancel()
    tick = $.clock.every(15000, () => {
      void onTick($)
    })

    return next(e)
  })

  on('command.run', { command: 'token-chart' }, async ($, e) => {
    const parts = (e.args ?? '').trim().split(' ').filter(Boolean)
    if (parts[0] === 'reset' && parts.length === 1) {
      for (const key of await $.store.keys()) await $.store.delete(key)
      await update($, turns, () => [])
      await update($, cacheWeight, () => DEFAULT_CACHE_WEIGHT)
      FIT = priorFit(null)
      $.ui.invalidate('ui.render')

      return { text: t('resetDone') }
    }
    if (parts[0] === 'cache' && parts[1] === 'auto' && parts.length === 2) {
      await $.store.set('manualCache', false)
      await refit($)

      return { text: t('cacheAuto') }
    }
    if (parts[0] === 'cache') {
      const value = Number(parts[1])
      if (parts.length !== 2 || Number.isNaN(value) || value < 0 || value > 1) return { text: t('cacheBad') }
      await $.store.set('cacheWeight', value)
      await $.store.set('manualCache', true)
      await refit($)

      return { text: `${t('cacheSet')} ${value}` }
    }

    await syncFit($)
    const opened = await $.ui.open({ id: PANE, title: t('title') })
    const windows = await read($, limits)
    const hasFive = windows.some(w => w.kind === 'five_hour')
    const list = inWindow(await readTurns($), windows)
    const spent = await read($, cost)
    const weight = await read($, cacheWeight)
    const now = await $.clock.now()
    const lines = windows.map(
      w => `${nameOfLimit(w.kind)}: ${Math.round(w.percentUsed)}% · ${remaining(w.resetsAt, now)}`,
    )
    const total = list.reduce((a, b) => a + b.tokens, 0)
    const models = [...sumByModel(list, weight).entries()].map(
      ([m, o]) =>
        `${nameOf(m)}: ${hasFive ? `~${o.points.toFixed(1)}% ` : ''}(${compact(o.tokens)} (in ${compact(o.input)} · out ${compact(o.output)} · ${t('cacheWritten')} ${compact(o.cacheWrite)}) + ${compact(o.cacheRead)} ${t('cacheRead')}, ${o.turns} ${t('calls')})`,
    )
    const head = opened.isPlaced
      ? t('opened')
      : `${t('notDrawn')} ${opened.reason}`

    return {
      text: [
        head,
        ...(hasFive ? lines : [...lines, t('noLimits')]),
        `${t('summary')}: ${compact(total)} / ${list.length} ${t('calls')}`,
        `${t('spent')}: ${money(spent)}`,
        `${t('cacheShare')}: ${fmtW(weight)} (${cacheShare(list, weight)}%)`,
        `${t('learned')}: ${weightsText(list)}`,
        `${t('reliability')}: ±${spreadNow()}% · ${t('needFor5')} ${needFor(5)} ${t('points')}`,
        ...(FIT.used < FIT.n ? [`${FIT.n - FIT.used} ${t('droppedWhy')}`] : []),
        driftText(),
        estimateText(list),
        ...models,
      ].join(String.fromCharCode(10)),
    }
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (u) {
      const turn: Turn = {
        tokens: u.input_tokens + u.output_tokens + u.cache_creation_input_tokens,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        cacheRead: u.cache_read_input_tokens,
        model: u.model,
        at: await $.clock.now(),
      }
      // The running totals first: they are what the learning needs, and they never shrink, so the
      // readings taken at two crossings can be subtracted whatever has left the list of calls.
      const key = await accKey($)
      const mine = totalsOf(((await $.store.get(key)) as { x?: unknown } | undefined)?.x)
      addTo(mine, familyOf(turn.model), turn.input + 5 * turn.output + 1.25 * turn.cacheWrite, turn.cacheRead)
      await safeSet($, key, { at: turn.at, x: mine })
      await update($, turns, list => prune([...(list as unknown[]).filter(isTurn), turn], turn.at))
      const list = await readTurns($)
      if (!(await safeSet($, 'turns', list))) await safeSet($, 'turns', list.slice(-(list.length >> 1)))
      $.ui.invalidate('ui.render')
    }

    return r
  })

  on('prompt.submit', ($, e, next) => {
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // Compacting rewrites the whole prompt cache in a call of its own, which says nothing about how a
  // point of the limit is weighed: the interval that spans it is left out of the learning.
  on('session.compact', async ($, e, next) => {
    await $.store.set('skipInterval', true)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const next_: Limit[] = e.rateLimits.map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt,
    }))
    await update($, limits, () => next_)
    await safeSet($, 'limits', next_)
    if (e.cost) {
      const usd = e.cost.usd
      await update($, cost, () => usd)
    }
    const five = next_.find(l => l.kind === 'five_hour')
    if (five?.resetsAt) {
      const reset = five.resetsAt
      // One reading shared by every session: the first to see the limit move takes the interval.
      const last = (await $.store.get('last')) as { p?: unknown; f?: unknown; reset?: unknown } | undefined
      const same = typeof last?.reset === 'string' && isNum(last.p) && sameWindow(last.reset, reset)
      // Within a window the limit only goes up: a lower reading is a late one (calls running in
      // parallel answer out of order) and is left alone, or the next crossing would be measured
      // from it.
      if (!same || (isNum(last?.p) && five.percentUsed > last.p)) {
        const f = await sumAcc($)
        if (same && isNum(last?.p)) {
          const before = totalsOf(last.f)
          const x: Totals = {}
          let valid = true
          for (const [fam, [a, c]] of Object.entries(f)) {
            const [a0, c0] = before[fam] ?? [0, 0]
            if (a - a0 < 0 || c - c0 < 0) valid = false
            if (a > a0 || c > c0) x[fam] = [a - a0, c - c0]
          }
          const skip = (await $.store.get('skipInterval')) === true
          if (skip) await $.store.set('skipInterval', false)
          const end = `${reset}|${five.percentUsed}`
          const intervals = intervalsFrom(await $.store.get('intervals'))
          if (valid && !skip && Object.keys(x).length > 0 && !intervals.some(iv => iv.end === end)) {
            await safeSet($, 'intervals', [...intervals, { x, dp: five.percentUsed - last.p, end }].slice(-IV_KEEP))
            await refit($)
          }
        }
        await safeSet($, 'last', { p: five.percentUsed, f, reset })
      }
    }
    await refreshStatus($)
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const windows = await read($, limits)
    const hasFive = windows.some(w => w.kind === 'five_hour')
    const list = inWindow(await readTurns($), windows)
    const spent = await read($, cost)
    const weight = await read($, cacheWeight)
    const now = await $.clock.now()
    const inner = Math.max(12, (e.props.bodyColumns ?? 34) - 4)
    const barWidth = Math.max(8, inner - 6)
    const bucket = Math.max(1, Math.ceil(list.length / inner))
    const recent: { tokens: number; model: string }[] = []
    for (let i = 0; i < list.length; i += bucket) {
      const group = list.slice(i, i + bucket)
      const byTokens = new Map<string, number>()
      for (const g of group) byTokens.set(g.model, (byTokens.get(g.model) ?? 0) + g.tokens)
      const model = [...byTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
      recent.push({ tokens: group.reduce((a, b) => a + b.tokens, 0), model })
    }
    const peak = Math.max(1, ...recent.map(t => t.tokens))
    const sum = list.reduce((a, b) => a + b.tokens, 0)
    const byModel = sumByModel(list, weight)
    const last = list[list.length - 1]
    const current = last?.model
    const rows = Array.from({ length: CHART_ROWS }, (_, r) => r)

    const cell = (v: number, r: number) => {
      const level = Math.round((v / peak) * CHART_ROWS * 8)
      const left = level - (CHART_ROWS - 1 - r) * 8

      return left <= 0 ? ' ' : left >= 8 ? '█' : BLOCKS[left - 1]
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text bold color="claude">
            {t('limitsHead')}
          </Text>
          {!hasFive && <Text dimColor>{t('noLimits')}</Text>}
          {windows.map(w => {
            const state = status(w.percentUsed)

            return (
              <Box key={w.kind} flexDirection="column" marginTop={1}>
                <Box justifyContent="space-between">
                  <Text bold>{nameOfLimit(w.kind)}</Text>
                  <Text color={state.color} bold>
                    {state.label}
                  </Text>
                </Box>
                <Text>
                  <Text color={state.color}>{bar(w.percentUsed, barWidth).filled}</Text>
                  <Text color="inactive">{bar(w.percentUsed, barWidth).empty}</Text>
                  <Text bold> {String(Math.round(w.percentUsed)).padStart(3)}%</Text>
                </Text>
                <Text dimColor>⟳ {remaining(w.resetsAt, now)}</Text>
                {w.kind === 'five_hour' && <Text dimColor>{estimateText(list)}</Text>}
                {w.kind === 'five_hour' && (
                  <Text dimColor>
                    {t('reliability')} {reliabilityText()}
                  </Text>
                )}
                {w.kind === 'five_hour' && (
                  <Text color={isDriftAlarm() ? 'warning' : undefined} dimColor={!isDriftAlarm()}>
                    {driftText()}
                  </Text>
                )}
              </Box>
            )
          })}
          <Box justifyContent="space-between" marginTop={1}>
            <Text dimColor>{t('sessionCost')}</Text>
            <Text bold>{money(spent)}</Text>
          </Box>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text bold color="claude">
            {t('chartHead')}
          </Text>
          {list.length === 0 ? (
            <Text dimColor>{t('noTurns')}</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>
                {t('axisY')} · 0–{compact(peak)}
              </Text>
              {rows.map(r => (
                <Box key={String(r)}>
                  {recent.map((t, i) => (
                    <Text key={String(i)} color={colorOf(t.model)} bold={i === recent.length - 1}>
                      {cell(t.tokens, r)}
                    </Text>
                  ))}
                </Box>
              ))}
              <Text color="inactive">{'─'.repeat(Math.max(1, recent.length))}</Text>
              <Text dimColor>
                {t('axisX')} · 1 {t('bar')} = {bucket} {bucket === 1 ? t('call') : t('calls')}
              </Text>
              <Box justifyContent="space-between">
                <Text dimColor>{t('lastCall')}</Text>
                <Text bold>
                  {compact(last?.tokens ?? 0)} {t('tokenUnit')}
                </Text>
              </Box>
              <Box justifyContent="space-between">
                <Text dimColor>{t('maxBar')}</Text>
                <Text bold>
                  {compact(peak)} {t('tokenUnit')}
                </Text>
              </Box>
              <Box justifyContent="space-between">
                <Text dimColor>
                  {t('used')} ({list.length} {t('calls')})
                </Text>
                <Text bold>
                  {compact(sum)} {t('tokenUnit')}
                </Text>
              </Box>
              <Box justifyContent="space-between">
                <Text dimColor>
                  {t('cacheShare')} {fmtW(weight)}
                </Text>
                <Text bold>{cacheShare(list, weight)}%</Text>
              </Box>
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>{t('perModel')}</Text>
                {[...byModel.entries()].map(([model, one]) => (
                  <Box key={model} flexDirection="column">
                    <Box justifyContent="space-between">
                      <Text color={colorOf(model)} bold={model === current}>
                        ■ {nameOf(model)}
                        {model === current ? ' ←' : ''}
                      </Text>
                      <Text bold>
                        {hasFive ? `~${one.points.toFixed(1)}% ` : ''}
                        <Text dimColor>
                          ({compact(one.tokens)} {t('tokenUnit')})
                        </Text>
                      </Text>
                    </Box>
                    <Text dimColor>
                      in {compact(one.input)} · out {compact(one.output)} · cache {compact(one.cacheWrite)}+
                      {compact(one.cacheRead)} {t('cacheRead')}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
