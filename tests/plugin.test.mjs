import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(here, '..', 'desktop', 'plugin.js')

/**
 * The app loads the entry uncompiled and may import only the plugin SDK, so
 * the tests evaluate the very same source with stubs instead of a bundle.
 *
 * Unlike the focusedUsage-based plugins, tokstat is event-driven: we stub
 * host.onEvent to capture the ticker/message handlers and fire them.
 */
function loadPlugin(focusKey = 's1') {
  const source = readFile(ENTRY, 'utf8').then(async s => {
    const body = s
      .replace(/^import .*\n/gm, '')
      .replace('export default plugin', 'return plugin')
    const handlers = {}
    const listeners = { 'session.usage': [], 'message.start': [], 'message.complete': [] }
    const atom = (init) => {
      let v = init
      return {
        get: () => v,
        set: (n) => { v = typeof n === 'function' ? n(v) : n },
      }
    }
    const host = {
      state: {
        focusedSessionId: { get: () => null },
        focusedStoredSessionId: { get: () => focusKey },
      },
      onEvent(type, fn) {
        (handlers[type] ??= []).push(fn)
        listeners[type].push(fn)
        return () => { }
      },
    }
    const useValue = (a) => a.get()
    const jsx = (type, props) => (typeof type === 'function' ? type(props) : { type, props })
    // Collect effects and run them after first render, like React does.
    let pendingEffects = []
    const useEffect = (fn) => { pendingEffects.push(fn) }
    const flushEffects = () => { pendingEffects.forEach(f => f()); pendingEffects = [] }
    const plugin = new Function('host', 'useValue', 'jsx', 'atom', 'useEffect', 'flushEffects', body)(host, useValue, jsx, atom, useEffect, flushEffects)

    const contributions = []
    plugin.register({
      register: c => contributions.push(c),
      i18n: {
        register: () => { },
        t: (key, ...args) => {
          const s = key.startsWith('tip.') || key.startsWith('label.')
            ? { 'label.total': 'Total', 'label.turn': 'Turn', 'label.last': 'Last', 'label.ctx': 'Context', 'label.cache': 'Cache', 'tip.idle': 'No usage reported yet for the focused session.', 'tip.legend': 'legend', 'tip.cache': 'Cache hit: {0}%', 'tip.ctx': 'Context used: {0}%', 'tip.model': 'Model: {0}', 'tip.total': 'Total: {0} (input {1} / output {2})', 'tip.turn': 'This turn: {0}', 'tip.last': 'Last turn: {0}' }[key] ?? key
            : key
          return s.replace(/\{(\d)\}/g, (m, i) => String(args[+i] ?? m))
        },
      },
    })

    const fire = (type, payload, sid = focusKey) => listeners[type].forEach(fn => fn({ session_id: sid, payload }))
    const render = () => { const el = contributions[0].render(); flushEffects(); return el }
    render() // mount: register event handlers (React runs effects after first paint)
    return {
      contributions,
      fire,
      ticker: (usage, sid = focusKey) => fire('session.usage', { usage }, sid),
      start: (sid = focusKey) => fire('message.start', {}, sid),
      complete: (usage, sid = focusKey) => fire('message.complete', usage ? { usage } : {}, sid),
      render,
    }
  })
  return source
}

const digits = value => String(value).replace(/\D/g, '')

test('registers one right-aligned status bar item', async () => {
  const { contributions } = await loadPlugin()
  assert.equal(contributions.length, 1)
  assert.equal(contributions[0].area, 'statusBar.right')
  assert.equal(contributions[0].id, 'tokstat')
  assert.equal(contributions[0].order, 135)
})

test('renders an idle placeholder before any usage', async () => {
  const item = await loadPlugin()
  const { props } = item.render()
  assert.equal(props.children, 'Total —')
})

test('live turn counter grows with the ticker, not equal to total', async () => {
  const item = await loadPlugin()
  item.start()
  item.ticker({ input: 1000, output: 50, total: 1050 })
  item.ticker({ input: 1000, output: 250, total: 1250 })

  const { props } = item.render()
  assert.ok(String(props.children).includes('Turn'), props.children)
  assert.ok(digits(String(props.children)).includes('200'), 'turn delta should be 200, got ' + props.children)
  assert.ok(!String(props.children).includes('Last'), 'no last turn yet')
})

test('message.complete finalizes the turn into "Last"', async () => {
  const item = await loadPlugin()
  item.start()
  item.ticker({ input: 1000, output: 50, total: 1050 })
  item.ticker({ input: 1000, output: 250, total: 1250 })
  // complete in this build carries no usage — finalize from last ticker.
  item.complete(null)

  const { props } = item.render()
  assert.ok(String(props.children).includes('Last'), props.children)
  assert.ok(digits(String(props.children)).includes('200'), 'last delta should be 200, got ' + props.children)
  assert.ok(!String(props.children).includes('Turn'), 'live counter cleared after complete')
})

test('cumulative total is shown compactly', async () => {
  const item = await loadPlugin()
  item.ticker({ input: 1138432, output: 2947, total: 1141379, cache_hit_pct: 56, context_percent: 97 })
  const { props } = item.render()
  assert.ok(String(props.children).includes('1.1M'), props.children)
  assert.ok(String(props.children).includes('97%'), props.children)
  assert.ok(String(props.children).includes('56%'), props.children)
})

test('tooltip spells exact figures', async () => {
  const item = await loadPlugin()
  item.start()
  item.ticker({ input: 1000, output: 250, total: 1250 })
  const { props } = item.render()
  assert.ok(digits(props.title).includes('1250'), props.title)
})

test('per-session isolation: another session does not clobber focus', async () => {
  const item = await loadPlugin('s1')
  item.start('s1')
  item.ticker({ input: 100, output: 10, total: 110 }, 's1')
  // another session ticks; focused s1 must be untouched.
  item.ticker({ input: 900, output: 90, total: 990 }, 's2')
  const { props } = item.render()
  assert.ok(digits(props.children).includes('110'), props.children)
})
