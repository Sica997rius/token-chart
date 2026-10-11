import { describe, expect, mock, test } from 'claude-code/testing'

type U = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  model: string
}

const usage = (model: string, input: number, output: number, write: number, read: number): U => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  model,
})

// Sets up what sits beneath the plugin and returns a function that plays one model call.
const setup = (on: any, entries?: Record<string, unknown>) => {
  mock.clock(on)
  mock.store(on, entries)
  let current: U = usage('x', 0, 0, 0, 0)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: current }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return async ($: any, u: U) => {
    current = u
    const stream = $.turn.step({ turnId: 't', index: 0, model: u.model, messageCount: 1 })
    for await (const _ of stream) void _
    await stream.result
  }
}

const mountPane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'token-chart',
    surface,
    component: 'Pane',
    requestId: 'token-chart',
    props: { title: 'Token usati', bodyColumns: 40 },
  })

// A simulated account: each model's true weight, the true size of a point, the true cache weight.
// Calls are random (model and doses), and the limit is reported at every whole point it crosses.
type World = { perPoint: number; scale: Record<string, number>; cache: number }
const simulator = ($: any, on: any, world: World, seed0 = 12345) => {
  const play = setup(on)
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  const resetsAt = new Date(3 * 3600 * 1000).toISOString()
  const measure = (percentUsed: number) =>
    $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })
  let seed = seed0
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296

    return seed / 4294967296
  }
  const logu = (lo: number, hi: number) => Math.round(lo * (hi / lo) ** rnd())
  const names = Object.keys(world.scale)
  let shown = 0
  let base = 0
  let cum = 0

  return {
    // plays calls until the limit has moved by `points` whole points; `extra` adds points that
    // no call of this install explains (usage elsewhere)
    run: async (points: number, extra: (p: number) => number = () => 0) => {
      const target = shown + points
      while (shown < target) {
        const model = names[Math.floor(rnd() * names.length)] ?? 'claude-sonnet-5-5'
        const input = logu(1000, 40000)
        const output = logu(300, 4000)
        const write = logu(1000, 30000)
        const read = logu(10000, 2000000)
        await play($, usage(model, input, output, write, read))
        cum += (world.scale[model] ?? 1) * (input + 5 * output + 1.25 * write + world.cache * read)
        const p = base + Math.floor(cum / world.perPoint)
        if (p > shown) {
          const more = extra(p)
          base += more
          shown = p + more
          await measure(shown)
        }
      }
    },
    start: () => measure(0),
    report: async () => (await $.command.run({ command: 'token-chart' })).text as string,
  }
}
const num = (text: string, re: RegExp) => Number((re.exec(text) ?? [])[1])
const perPointOf = (text: string) => num(text, /Sonnet 1% ≈ ([0-9.]+)k/) * 1000

describe('token-chart', () => {
  test('il comando riassume i token per modello senza contare la cache letta', async ($: any, on: any) => {
    const play = setup(on)
    await $.command.run({ command: 'token-chart' }).catch(() => undefined)
    await play($, usage('claude-sonnet-5-5', 100, 50, 10, 1000))
    await play($, usage('claude-opus-5-5', 200, 100, 0, 5000))

    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('Sonnet 5.5')
    expect(r.text).toContain('Opus 5.5')
    // Sonnet: 100 + 50 + 10 = 160 consumati; la cache letta (1000) resta fuori dal totale
    expect(r.text).toContain('160')
    expect(r.text).not.toContain('NaN')
  })

  test('il pannello si disegna su terminale e desktop', async ($: any, on: any) => {
    const play = setup(on)
    await play($, usage('claude-haiku-5-5', 10, 5, 0, 0))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: /FINESTRA 5 ORE/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('senza dati il pannello non si rompe', async ($: any, on: any) => {
    setup(on)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Nessun turno ancora/ })).toBeDefined()
    await ui.unmount()
  })

  test('i limiti arrivano da session.measure e finiscono nel riepilogo e nel pannello', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    await play($, usage('claude-sonnet-5-5', 1000, 500, 0, 0))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    await $.session.measure({
      context: {},
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt },
        { kind: 'seven_day', percentUsed: 7, resetsAt },
      ],
      cost: { usd: 1.234 },
      changed: ['rateLimits'],
    })

    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('Sessione (5 ore): 42%')
    expect(r.text).toContain('Settimana (7 giorni): 7%')
    expect(r.text).toContain('$1.23')

    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /LIMITE 5 ORE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /valori iniziali/ })).toBeDefined()
    await ui.unmount()
  })

  test('in inglese il riepilogo e il pannello usano i testi inglesi', { options: { language: 'en' } }, async ($: any, on: any) => {
    const play = setup(on)
    await play($, usage('claude-sonnet-5-5', 100, 50, 0, 0))
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('Session cost')
    expect(r.text).not.toContain('Spesa')
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /5-HOUR WINDOW/ })).toBeDefined()
    await ui.unmount()
  })

  test('il massimo si ricava da quanti token hanno mosso la percentuale', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    const measure = (percentUsed: number) =>
      $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })

    await play($, usage('claude-sonnet-5-5', 1000, 0, 0, 0)) // prima del primo rilievo: non conta
    await measure(10)
    await play($, usage('claude-sonnet-5-5', 30000, 10000, 0, 0)) // 40k token ...
    await measure(14) // ... hanno mosso la finestra di 4 punti: 10k per 1% -> max 1M

    const r = await $.command.run({ command: 'token-chart' })
    // la dimensione del punto dipende dal piano: si prende dai dati fin dal primo intervallo
    const perPoint = Number(/\(([0-9.]+)k per 1%\)/.exec(r.text)?.[1])
    expect(perPoint).toBeGreaterThan(19)
    expect(perPoint).toBeLessThan(21)
  })

  test('il peso della cache letta si regola con /token-chart cache e cambia la quota', async ($: any, on: any) => {
    const play = setup(on)
    await play($, usage('claude-sonnet-5-5', 100, 0, 0, 1000000))
    const base = await $.command.run({ command: 'token-chart' })
    expect(base.text).toContain('peso cache letta: 0.03')
    const set = await $.command.run({ command: 'token-chart', args: 'cache 0.1' })
    expect(set.text).toContain('0.1')
    const after = await $.command.run({ command: 'token-chart' })
    expect(after.text).toContain('peso cache letta: 0.1')
    const bad = await $.command.run({ command: 'token-chart', args: 'cache 7' })
    expect(bad.text).toContain('Uso:')
  })

  test('il mod ritrova i pesi veri dai passaggi di punto', async ($: any, on: any) => {
    // Pesi "veri" del mondo simulato, diversi dai valori di partenza del mod
    const world = { perPoint: 80000, scale: { 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 2.1, 'claude-haiku-5-5': 0.12 }, cache: 0.05 }
    const sim = simulator($, on, world)
    await sim.start()
    await sim.run(60)
    const r = await sim.report()
    expect(perPointOf(r)).toBeGreaterThan(80000 * 0.85)
    expect(perPointOf(r)).toBeLessThan(80000 * 1.15)
    expect(num(r, /Opus x([0-9.]+)/)).toBeGreaterThan(2.1 * 0.75)
    expect(num(r, /Opus x([0-9.]+)/)).toBeLessThan(2.1 * 1.25)
    expect(num(r, /Haiku x([0-9.]+)/)).toBeGreaterThan(0.12 * 0.6)
    expect(num(r, /Haiku x([0-9.]+)/)).toBeLessThan(0.12 * 1.4)
  })

  for (const [plan, perPoint] of [['Pro', 20000], ['Max 20x', 450000]] as const) {
    test(`su un piano ${plan} la dimensione del punto si trova anche se lontana da quella iniziale`, async ($: any, on: any) => {
      const world = { perPoint, scale: { 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 1.5, 'claude-haiku-5-5': 0.07 }, cache: 0.03 }
      const sim = simulator($, on, world, 777)
      await sim.start()
      await sim.run(20)
      const r = await sim.report()
      expect(perPointOf(r)).toBeGreaterThan(perPoint * 0.8)
      expect(perPointOf(r)).toBeLessThan(perPoint * 1.2)
    })
  }

  test('un modello mai misurato (Fable) ha un peso suo e non sporca quello di Sonnet', async ($: any, on: any) => {
    const world = {
      perPoint: 100000,
      scale: { 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 1.5, 'claude-haiku-5-5': 0.07, 'claude-fable-5-1': 4 },
      cache: 0.03,
    }
    const sim = simulator($, on, world, 4242)
    await sim.start()
    await sim.run(60)
    const r = await sim.report()
    expect(r).toContain('Fable 5.1')
    expect(perPointOf(r)).toBeGreaterThan(100000 * 0.8)
    expect(perPointOf(r)).toBeLessThan(100000 * 1.2)
    expect(num(r, /Fable x([0-9.]+)/)).toBeGreaterThan(4 * 0.7)
    expect(num(r, /Fable x([0-9.]+)/)).toBeLessThan(4 * 1.3)
  })

  test('due sessioni sullo stesso PC: i token di entrambe contano e il passaggio non si conta due volte', async ($: any, on: any) => {
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    // l'ultima lettura (10%) e quello che l'altra sessione ha consumato dopo, sotto la sua chiave
    const play = setup(on, {
      last: { p: 10, f: {}, reset: resetsAt },
      'acc:altra-sessione': { at: 0, x: { sonnet: [30000, 0] } },
    })
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    const measure = (percentUsed: number) =>
      $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })
    await play($, usage('claude-sonnet-5-5', 30000, 0, 0, 0))
    await measure(11)
    // anche l'altra sessione vede lo stesso passaggio: non deve diventare un secondo intervallo
    await measure(11)
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('n=1')
    expect(perPointOf(r.text)).toBeGreaterThan(59000)
    expect(perPointOf(r.text)).toBeLessThan(61000)
  })

  test('una lettura arrivata in ritardo non falsa il passaggio successivo', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    const measure = (percentUsed: number) =>
      $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })
    await measure(10)
    await play($, usage('claude-sonnet-5-5', 50000, 0, 0, 0))
    await measure(11)
    await play($, usage('claude-sonnet-5-5', 50000, 0, 0, 0))
    await measure(10) // risposta in ritardo di una chiamata partita prima
    await measure(12)
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('n=2')
    expect(perPointOf(r.text)).toBeGreaterThan(49000)
    expect(perPointOf(r.text)).toBeLessThan(51000)
  })

  test('il consumo fuori da questa installazione viene scartato e segnalato', async ($: any, on: any) => {
    const world = { perPoint: 100000, scale: { 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 1.5, 'claude-haiku-5-5': 0.07 }, cache: 0.03 }
    const sim = simulator($, on, world, 99)
    await sim.start()
    // ogni 7 punti qualcuno usa claude.ai e il limite salta di 3 punti in più senza token visti qui
    await sim.run(50, p => (p % 7 === 0 ? 3 : 0))
    const r = await sim.report()
    expect(r).toContain('passaggi scartati')
    expect(perPointOf(r)).toBeGreaterThan(100000 * 0.85)
    expect(perPointOf(r)).toBeLessThan(100000 * 1.15)
  })

  test("i passaggi aggiunti da un'altra chat arrivano anche qui senza aspettare un passaggio nuovo", async ($: any, on: any) => {
    // l'archivio condiviso contiene già 12 passaggi scritti da un'altra chat; questa non ha visto nulla
    setup(on, { intervals: Array.from({ length: 12 }, () => ({ x: { sonnet: [90000, 0] }, dp: 1 })) })
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('n=12')
    expect(perPointOf(r.text)).toBeGreaterThan(89000)
    expect(perPointOf(r.text)).toBeLessThan(91000)
  })

  test('il pannello mostra come i token visti e quelli non visti arrivano alla percentuale del limite', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    // 108k token Sonnet di input valgono esattamente l'1% con i valori iniziali
    await play($, usage('claude-sonnet-5-5', 108000, 0, 0, 0))
    await $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt }], changed: ['rateLimits'] })
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('Come si arriva al 10%: visti dalla mod 1.0%')
    expect(r.text).toContain('non visti (claude.ai, altri PC…) 9.0%')
    expect(r.text).toContain('input 108.0k ×1 = 108.0k')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: /= 1\.0% visti dalla mod/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /= 9\.0%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /= limite 5 ore/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /DI COSA È FATTO/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('mostra i token rimanenti per ogni modello, anche per quelli non usati', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    // 108k token Sonnet di input = 1% con i valori iniziali; il limite è al 40%, quindi restano 60%
    await play($, usage('claude-sonnet-5-5', 108000, 0, 0, 0))
    await $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt }], changed: ['rateLimits'] })
    const r = await $.command.run({ command: 'token-chart' })
    // Sonnet: 60 x 108k = 6.5M pesati, 1.3M se fosse tutto output; Opus pesa 1.5x, Haiku 0.07x
    expect(r.text).toContain('Quanto ti resta (60% del limite)')
    expect(r.text).toContain('Sonnet 5.5 6.5M pesati (≈ 1.3M solo output, ~60 chiamate, ×1.0 Sonnet)')
    // la stessa chiamata media (108k pesati) per tutti: Opus 4.3M / 108k = 40, Haiku 92.6M / 108k = 857
    expect(r.text).toContain('Opus 4.3M pesati (≈ 864.0k solo output, ~40 chiamate, ×0.7 Sonnet)')
    expect(r.text).toContain('Haiku 92.6M pesati (≈ 18.5M solo output, ~857 chiamate, ×14 Sonnet)')
    expect(r.text).toContain('A parità di lavoro (chiamata media 108.0k pesati): Haiku ×14 le chiamate di Sonnet · Opus ×0.7 le chiamate di Sonnet')
    expect(r.text).toContain('Conviene: Haiku per compiti semplici')
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /QUANTO TI RESTA/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /A parità di lavoro/ })).toBeDefined()
    await ui.unmount()
  })

  test('a parità di lavoro Opus dà sempre meno chiamate di Sonnet, anche se le tue chiamate Opus erano piccole', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    // una chiamata Sonnet grande e dieci chiamate Opus piccole
    await play($, usage('claude-sonnet-5-5', 100000, 0, 0, 0))
    for (let i = 0; i < 10; i++) await play($, usage('claude-opus-5-5', 2000, 0, 0, 0))
    await $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt }], changed: ['rateLimits'] })
    const text = (await $.command.run({ command: 'token-chart' })).text as string
    const callsOf = (name: string) => {
      const m = new RegExp(`${name}(?: 5\\.5)? [^(]*\\(≈ [^,]*, ~([0-9.]+)(k?) chiamate`).exec(text) ?? []

      return Number(m[1]) * (m[2] === 'k' ? 1000 : 1)
    }
    expect(callsOf('Opus')).toBeLessThan(callsOf('Sonnet'))
    expect(callsOf('Haiku')).toBeGreaterThan(callsOf('Sonnet'))
    // il rapporto è quello dei pesi: Opus 1.5 volte Sonnet
    expect(Math.abs(callsOf('Sonnet') / callsOf('Opus') - 1.5)).toBeLessThan(0.02)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`toccare un modello apre il suo dettaglio e toccarlo ancora lo chiude (${surface})`, async ($: any, on: any) => {
      const play = setup(on)
      on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
      const resetsAt = new Date(3 * 3600 * 1000).toISOString()
      await play($, usage('claude-sonnet-5-5', 54000, 2000, 10000, 100000))
      await play($, usage('claude-opus-5-5', 20000, 1000, 5000, 400000))
      await $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 5, resetsAt }], changed: ['rateLimits'] })
      const ui = await mountPane($, surface)
      // nessun dettaglio aperto all'inizio
      expect(await ui.find({ type: 'Text', text: /DETTAGLIO/ })).toBeUndefined()
      await ui.press({ key: 'pick-legend-opus' })
      expect(await ui.find({ type: 'Text', text: /DETTAGLIO · Opus 5\.5/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1% = 72\.\dk token pesati Opus/ })).toBeDefined()
      // un altro modello sostituisce il dettaglio
      await ui.press({ key: 'pick-table-sonnet' })
      expect(await ui.find({ type: 'Text', text: /DETTAGLIO · Sonnet 5\.5/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /DETTAGLIO · Opus/ })).toBeUndefined()
      // lo stesso modello di nuovo: si chiude
      await ui.press({ key: 'pick-left-sonnet' })
      expect(await ui.find({ type: 'Text', text: /DETTAGLIO/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('senza abbonamento non mostra percentuali inventate', async ($: any, on: any) => {
    const play = setup(on)
    await play($, usage('claude-sonnet-5-5', 1000, 100, 0, 0))
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('Nessun limite di 5 ore')
    expect(r.text).not.toMatch(/Sonnet 5\.5: ~/)
  })

  test('/token-chart reset cancella i dati e torna ai valori iniziali', async ($: any, on: any) => {
    const world = { perPoint: 50000, scale: { 'claude-sonnet-5-5': 1 }, cache: 0.03 }
    const sim = simulator($, on, world, 5)
    await sim.start()
    await sim.run(5)
    expect(await sim.report()).not.toContain('n=0')
    const done = await $.command.run({ command: 'token-chart', args: 'reset' })
    expect(done.text).toContain('cancellati')
    const r = await sim.report()
    expect(r).toContain('n=0')
    expect(r).toContain('stima iniziale')
  })

  test('i dati della versione 1.0 vengono convertiti, non persi', async ($: any, on: any) => {
    setup(on, {
      acc: [1000, 2000, 3000, 4000, 5000, 6000],
      intervals: Array.from({ length: 12 }, () => ({ x: [100000, 0, 0, 0, 0, 0], dp: 1 })),
    })
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('n=12')
    expect(perPointOf(r.text)).toBeGreaterThan(99000)
    expect(perPointOf(r.text)).toBeLessThan(101000)
  })

  test('la variazione recente resta nella norma se nulla cambia e segnala un cambio dei limiti', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    const measure = (percentUsed: number) =>
      $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })
    const scale: Record<string, number> = { 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 2.1, 'claude-haiku-5-5': 0.12 }
    let shown = 0
    let base = 0
    let cum = 0
    let perPoint = 80000
    await measure(0)
    // Gioca dei turni con un certo valore di "token per punto" e riporta ogni punto guadagnato
    let seed = 12345
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296

      return seed / 4294967296
    }
    const logu = (lo: number, hi: number) => Math.round(lo * (hi / lo) ** rnd())
    const names = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
    const phase = async (rounds: number) => {
      for (let round = 0; round < rounds * 6; round++) {
        const model = names[Math.floor(rnd() * 3)] ?? 'claude-sonnet-5-5'
        const input = logu(1000, 40000)
        const output = logu(300, 4000)
        const write = logu(1000, 30000)
        const read = logu(10000, 2000000)
        await play($, usage(model, input, output, write, read))
        cum += (scale[model] ?? 1) * (input + 5 * output + 1.25 * write + 0.05 * read)
        const p = base + Math.floor(cum / perPoint)
        if (p > shown) {
          shown = p
          await measure(p)
        }
      }
    }
    // Da qui in poi un punto vale un altro numero di token
    const changeWorld = (next: number) => {
      base = shown
      cum = 0
      perPoint = next
    }
    const drift = async () => {
      const r = await $.command.run({ command: 'token-chart' })
      const line = r.text.split(String.fromCharCode(10)).find((l: string) => l.includes('variazione recente')) ?? ''

      return { line, value: Number((/([+-]\d+)%/.exec(line) ?? [])[1]) }
    }

    await phase(14)
    const calm = await drift()
    expect(calm.line).toContain('nella norma')
    expect(Math.abs(calm.value)).toBeLessThan(28)

    // I limiti si stringono: ogni punto ora costa molti meno token
    changeWorld(40000)
    await phase(6)
    const changed = await drift()
    expect(changed.line).toContain('CAMBIO PROBABILE')
    expect(changed.value).toBeGreaterThan(28)
  })

  test('senza abbastanza passaggi la variazione recente non si inventa', async ($: any, on: any) => {
    setup(on)
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('variazione recente: n/d')
  })

  test('il grafico non ha un massimo di chiamate e indica le unità', async ($: any, on: any) => {
    const play = setup(on)
    // molte più chiamate delle colonne: vanno raggruppate in barre, non scartate
    for (let i = 0; i < 300; i++) await play($, usage('claude-sonnet-5-5', 100, 10, 0, 0))
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /1 barra = \d+ chiamate/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /token per barra/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(300 chiamate\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('comprimere la sessione non falsa i pesi appresi', async ($: any, on: any) => {
    const play = setup(on)
    on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
    on('session.compact', (_: any, e: any) => ({ messages: e.messages }))
    const resetsAt = new Date(3 * 3600 * 1000).toISOString()
    const measure = (percentUsed: number) =>
      $.session.measure({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })
    await measure(10)
    await play($, usage('claude-sonnet-5-5', 100000, 0, 0, 0))
    await measure(11)
    // la compressione riscrive tutta la cache in una chiamata gigante: quell'intervallo non conta
    await $.session.compact({ trigger: 'plugin', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    await play($, usage('claude-sonnet-5-5', 100, 0, 5000000, 0))
    await measure(12)
    await play($, usage('claude-sonnet-5-5', 100000, 0, 0, 0))
    await measure(13)
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('n=2')
  })

  test('senza dati non promette nessuna precisione e lo dice', async ($: any, on: any) => {
    setup(on)
    const r = await $.command.run({ command: 'token-chart' })
    expect(r.text).toContain('nessuna misura tua ancora: valori iniziali, errore non noto')
    expect(r.text).not.toContain('±5%')
    expect(r.text).not.toContain('servono circa')
    expect(r.text).toContain('Sonnet iniziale')
  })

  test("con abbastanza misure mostra l'errore su dati nuovi, non quello sui dati già visti soltanto", async ($: any, on: any) => {
    const world = { perPoint: 90000, scale: { 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 1.5, 'claude-haiku-5-5': 0.07 }, cache: 0.03 }
    const sim = simulator($, on, world, 31)
    await sim.start()
    await sim.run(40)
    expect(await sim.report()).toContain('errore su dati nuovi: n/d, servono almeno 60 misure')
    await sim.run(60)
    const r = await sim.report()
    const typical = num(r, /errore su dati nuovi: tipico ±(\d+)%/)
    const worst = num(r, /peggiore (\d+)% sui 20 passaggi/)
    // dati simulati puliti: l'errore su 20 punti resta vicino al limite della risoluzione intera
    expect(typical).toBeLessThan(10)
    expect(worst).toBeGreaterThanOrEqual(typical)
    expect(r).toContain('sui dati già visti ±')
    expect(r).not.toContain('servono circa')
  })

  test('dice da dove viene il peso di ogni modello: misurato, dedotto o mai visto', async ($: any, on: any) => {
    // si usa solo Opus: Sonnet e Haiku non sono misurati con i dati dell'utente
    const world = { perPoint: 70000, scale: { 'claude-opus-5-5': 1.5, 'claude-fable-5-1': 3 }, cache: 0.03 }
    const sim = simulator($, on, world, 8)
    await sim.start()
    await sim.run(30)
    const r = await sim.report()
    expect(r).toMatch(/Opus misurato \d+/)
    expect(r).toContain('Sonnet dedotto')
    expect(r).toContain('Haiku dedotto')
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /non misurato: dedotto dagli altri modelli/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /non misurato con i tuoi dati/ })).toBeDefined()
    await ui.unmount()
  })
})
