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
 * The `usePluginI18n` stub mirrors the HOST, not the plugin: keys are resolved
 * by walking the registered bundle on '.', falling back to `en`, then to the
 * key itself. A flat `'label.total'` bundle therefore yields the raw key here
 * exactly as it does in the app — that is the whole point of not hand-rolling
 * a friendly stub.
 *
 * tokstat is event-driven: we stub host.onEvent to capture the ticker/message
 * handlers and fire them.
 */
function loadPlugin({ locale = 'en', focusKey = 's1' } = {}) {
  return readFile(ENTRY, 'utf8').then(s => {
    const body = s
      .replace(/^import .*\n/gm, '')
      .replace('export default plugin', 'return plugin')
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

    // --- host-faithful i18n -------------------------------------------------
    const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v)
    const walk = (tree, key) => key.split('.').reduce((cur, part) => (isRecord(cur) ? cur[part] : undefined), tree)
    const render = (value, args) =>
      typeof value === 'string' ? value : typeof value === 'function' ? value(...args) : null
    const bundles = {}
    const translate = (key, ...args) => {
      const active = render(walk(bundles[locale], key), args)
      if (active !== null) return active
      if (locale !== 'en') {
        const fallback = render(walk(bundles.en, key), args)
        if (fallback !== null) return fallback
      }
      return key
    }

    const plugin = new Function(
      'host', 'useValue', 'jsx', 'atom', 'useEffect', 'flushEffects', 'usePluginI18n', body
    )(host, useValue, jsx, atom, useEffect, flushEffects, () => translate)

    const contributions = []
    plugin.register({
      register: c => contributions.push(c),
      i18n: {
        register: (registered) => { Object.assign(bundles, registered); return () => { } },
        t: translate,
        onLocaleChange: () => () => { },
        registerAppLocale: () => () => { },
      },
    })

    const fire = (type, payload, sid = focusKey) => listeners[type].forEach(fn => fn({ session_id: sid, payload }))
    const renderItem = () => { const el = contributions[0].render(); flushEffects(); return el }
    renderItem() // mount: register event handlers (React runs effects after first paint)

    return {
      bundles,
      contributions,
      ticker: (usage, sid = focusKey) => fire('session.usage', { usage }, sid),
      start: (sid = focusKey) => fire('message.start', {}, sid),
      complete: (usage, sid = focusKey) => fire('message.complete', usage ? { usage } : {}, sid),
      render: renderItem,
    }
  })
}

const digits = value => String(value).replace(/\D/g, '')

test('registers one right-aligned status bar item', async () => {
  const { contributions } = await loadPlugin()
  assert.equal(contributions.length, 1)
  assert.equal(contributions[0].area, 'statusBar.right')
  assert.equal(contributions[0].id, 'tokstat')
  assert.equal(contributions[0].order, 135)
})

test('locale bundles are NESTED trees, not flat dotted keys', async () => {
  const { bundles } = await loadPlugin()
  for (const locale of ['en', 'zh']) {
    assert.ok(bundles[locale], `missing ${locale} bundle`)
    const dotted = Object.keys(bundles[locale]).filter(k => k.includes('.'))
    assert.deepEqual(dotted, [], `${locale} bundle has flat dotted keys the host cannot resolve: ${dotted}`)
    assert.equal(typeof bundles[locale].label.total, 'string')
    assert.equal(typeof bundles[locale].tip.idle, 'string')
    // Interpolated messages must be functions: the host returns plain strings
    // verbatim, so a `{0}` template would surface as literal braces.
    assert.equal(typeof bundles[locale].tip.total, 'function')
  }
  // Same leaf set in both locales — a missing zh key silently falls back to English.
  const leaves = (tree, prefix = '') =>
    Object.entries(tree).flatMap(([k, v]) =>
      typeof v === 'object' ? leaves(v, `${prefix}${k}.`) : [`${prefix}${k}`]).sort()
  assert.deepEqual(leaves(bundles.zh), leaves(bundles.en))
})

test('renders an idle placeholder before any usage', async () => {
  const item = await loadPlugin()
  const { props } = item.render()
  assert.equal(props.children, 'Total —')
})

test('follows the app locale: zh labels and tooltip, no raw keys', async () => {
  const item = await loadPlugin({ locale: 'zh' })
  item.start()
  item.ticker({ input: 1000, output: 50, total: 1050, context_percent: 12, cache_hit_pct: 80 })

  const { props } = item.render()
  assert.ok(String(props.children).startsWith('总量'), props.children)
  assert.ok(String(props.children).includes('本轮'), props.children)
  assert.ok(String(props.children).includes('上下文'), props.children)
  assert.ok(!/[a-z]+\.[a-z]+/.test(String(props.children)), 'raw i18n key leaked: ' + props.children)

  const title = String(props.title)
  assert.ok(title.includes('总量：累计'), title)
  assert.ok(title.includes('模型') || !title.includes('Model:'), title)
  assert.ok(!title.includes('{0}'), 'uninterpolated placeholder: ' + title)
  assert.ok(!/tip\.[a-z]+/.test(title), 'raw i18n key leaked: ' + title)
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
  const item = await loadPlugin()
  item.start('s1')
  item.ticker({ input: 100, output: 10, total: 110 }, 's1')
  // another session ticks; focused s1 must be untouched.
  item.ticker({ input: 900, output: 90, total: 990 }, 's2')
  const { props } = item.render()
  assert.ok(digits(props.children).includes('110'), props.children)
})
